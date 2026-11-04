// «⭕ Загрузка кругов» в блоке руководителя (решение 15.09.2026):
// план машин по шаблонам кругов ↔ факт недели ↔ дыра — ответ на вопрос
// «как загрузить парк» без запроса. План машин считается при живом
// зазоре стыковки (норматив «Зазор стыковки кругов» в 🧠 Живых
// нормативах); факт — рейсы за 7 дней по гружёным плечам круга, циклы
// по узкому плечу. Дыра = план − машины факта; цена дыры — маржа шаблона.
import { api, escapeHtml } from './api.js';

const money = value => `${Math.round(value).toLocaleString('ru-RU')} ₽`;

export async function ringLoadDialog(context) {
  let load;
  try {
    load = await api('/api/ring-load');
  } catch (error) {
    context.toast ? context.toast(error.message, 'error') : alert(error.message);
    return;
  }
  const rows = load.items
    .slice()
    .sort((a, b) => b.holeMarginMonth - a.holeMarginMonth)
    .map(item => {
      const short = item.name.split(' · ')[0];
      const title = item.name.split(' · ')[1] || '';
      const ringChip = item.ring
        ? (['done', 'cancelled'].includes(item.ring.status)
          ? `<span class="tt-chip" style="color:var(--bad)" title="${escapeHtml(item.ring.close_reason || '')}">⭕ ${escapeHtml(item.ring.route_no)} закрыто</span>`
          : `<span class="tt-chip">⭕ ${escapeHtml(item.ring.route_no)}</span>`)
        : '<span class="muted" style="font-size:11px">без кольца</span>';
      const holeCls = item.holeVehicles >= 3 ? 'style="color:var(--bad);font-weight:700"'
        : item.holeVehicles >= 1 ? 'style="color:var(--warn);font-weight:700"' : '';
      return `<tr>
        <td style="text-align:left"><b>${escapeHtml(short)}</b> ${ringChip}
          <small class="muted" style="display:block">${escapeHtml(title)}
            · объём шаблона ${item.volume}/мес · маржа/день ${money(item.marginDay)}</small></td>
        <td class="num">${item.planVehicles}</td>
        <td class="num" title="${escapeHtml(item.assigned.join(', ') || 'борта не закреплены — «План парка», колонка «Круг»')}">${item.assigned.length}</td>
        <td class="num" title="машин, сделавших хотя бы один полный цикл за ${load.windowDays} дн: ${item.week.vehicles}">${item.week.factVehicles}</td>
        <td class="num" title="полных циклов за ${load.windowDays} дн: ${item.week.cycles}">${item.week.cyclesWeek}</td>
        <td class="num" ${holeCls}>${item.holeVehicles || '—'}</td>
        <td class="num" ${holeCls}>${item.holeVehicles ? money(item.holeMarginMonth) : '—'}</td>
      </tr>`;
    }).join('');
  const totalHole = load.items.reduce((sum, item) => sum + item.holeVehicles, 0);
  const totalMoney = load.items.reduce((sum, item) => sum + item.holeMarginMonth, 0);
  const totalPlan = load.items.reduce((sum, item) => sum + item.planVehicles, 0);
  const totalFact = load.items.reduce((sum, item) => sum + item.week.factVehicles, 0);
  const totalAssigned = load.items.reduce((sum, item) => sum + item.assigned.length, 0);
  const round1 = value => Math.round(value * 10) / 10;
  context.showModal(`
    <h2 style="margin-bottom:2px">⭕ Загрузка кругов</h2>
    <div class="bi-page ring-page">
    <div class="bi-kpis">
      <div class="metric dept-drv"><span class="l">План машин</span>
        <span class="v">${round1(totalPlan)}<small>маш</small></span>
        <span class="d">зазор стыковки ${load.gap.days} дн</span></div>
      <div class="metric dept-drv"><span class="l">Закреплено</span>
        <span class="v">${totalAssigned}<small>маш</small></span>
        <span class="d">колонка «Круг» Плана парка</span></div>
      <div class="metric dept-log"><span class="l">Машин факт</span>
        <span class="v">${round1(totalFact)}<small>маш</small></span>
        <span class="d">полные циклы за ${load.windowDays} дн</span></div>
      <div class="metric ${totalHole >= 1 ? 'neg' : 'pos'}"><span class="l">Дыра</span>
        <span class="v">${round1(totalHole)}<small>маш</small></span>
        <span class="d">недобор объёма шаблонов</span></div>
      <div class="metric ${totalMoney > 0 ? 'neg' : 'pos'}"><span class="l">Цена дыры</span>
        <span class="v">${money(totalMoney)}</span>
        <span class="d">маржа шаблонов за месяц</span></div>
    </div>
    <section class="section dept-drv">
      <div class="sec-h"><span class="st">Круги: план ↔ факт ↔ дыра</span>
        <span class="hint">сортировка по цене дыры</span></div>
      <div class="sec-b flush"><div class="bi-scroll" style="max-height:52vh"><table class="bi-table">
      <thead><tr><th style="text-align:left">Круг</th>
        <th class="r">план машин</th><th class="r">закреплено</th><th class="r">машин факт</th><th class="r">циклов/нед</th>
        <th class="r">дыра, маш</th><th class="r">цена дыры, ₽/мес</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><td style="text-align:left"><b>Итого дыра</b></td><td></td><td></td><td></td><td></td>
        <td class="num"><b>${Math.round(totalHole * 10) / 10}</b></td>
        <td class="num"><b>${money(totalMoney)}</b></td></tr></tfoot>
    </table></div></div></section>
    <section class="section">
      <div class="sec-h"><span class="st">Как считается</span></div>
      <div class="sec-b"><p class="muted" style="margin:0 0 6px">План машин — объём шаблона при живом зазоре
      стыковки <b>${load.gap.days} дн</b>${load.gap.learned
    ? ` (медиана ${load.gap.samples} пар рейсов за 30 дн)` : ` (фолбэк: образцов ${load.gap.samples})`}.
      Факт — <b>полные циклы</b> за ${load.windowDays} дней: машина прошла плечи круга
      по порядку (плюс не больше одного рейса-заполнителя между плечами), каждый рейс
      засчитывается одному кругу. План и факт в одной единице — машины непрерывной
      занятости. Дыра = недобор объёма в машинах; цена — маржа шаблона за месяц.</p>
    <p class="muted" style="margin:0">Постоянные кольца стоят в Конструкторе (К-1, К-2п,
      К-4а, К-5): удалить нельзя, закрытие — только с причиной, она приходит вам уведомлением.
      Борта закрепляются в «Плане парка» (колонка «Круг»). Задание продажам по дырам — блок
      «⭕ Круги» во вкладке Продажи; итоги — строка «круги» в «📐 Нормативах недели» (пн 08:10).</p></div>
    </section>
    </div>`,
  'wide');
}
