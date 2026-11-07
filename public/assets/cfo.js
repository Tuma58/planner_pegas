// Экран «₽ ЦФО и затраты» (проект «Слияние», блок 3, 07.11.2026).
// Общий ЦФО направления — в Штабе (персональный доступ к затратам или
// должность «весь ЦФО»); руководителю отдела — только затраты его
// отдела, экран стоит в блоке его отдела. Деньги без НДС, факт — журнал
// «Затрат» (Dornet, РН-Карт, импорт, ручной ввод); статья без записей
// честно помечена «не вносится», норматив её не подменяет.
import { api, escapeHtml } from './api.js';

const rub = value => value == null ? '—' : `${Math.round(value).toLocaleString('ru-RU')} ₽`;
const mln = value => `${(value / 1e6).toLocaleString('ru-RU', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
const ruDay = iso => String(iso).split('-').reverse().join('.');
const MD_LABEL = { toir: 'на машино-день готовности', drv: 'на машино-день на линии', staff: 'на календарный машино-день' };

function articleRows(center) {
  return center.articles.map(item => `<tr class="${item.count ? '' : 'cfo-empty'}">
      <td>${escapeHtml(item.name)}${item.detail.length ? `<div class="cfo-detail">${item.detail.map(row =>
    `<span>${escapeHtml(row.key || 'без поставщика')} <b>${rub(row.net)}</b> · ${row.count}</span>`).join('')}</div>` : ''}</td>
      <td class="num">${item.count ? rub(item.net) : '<span class="muted" title="Записей за период нет — статья не вносится">не вносится</span>'}</td>
    </tr>`).join('');
}

function costCenter(center) {
  return `<section class="section s6 dept-${center.key} cfo-c">
    <div class="sec-h"><span class="st">${escapeHtml(center.name)}</span>
      <span class="owner-chip chip-${center.key}">${center.coef}</span><span class="hint">${center.cls}</span></div>
    <div class="sec-b">
      <div class="cfo-own muted">${center.owners.length ? center.owners.map(owner =>
    `${escapeHtml(owner.title)}${owner.people.length ? `: ${escapeHtml(owner.people.join(', '))}` : ' — вакансия'}`).join(' · ') : 'владелец не отмечен в «Структуре»'}</div>
      <div class="cfo-kpis">
        <div><span class="l">Затраты без НДС</span><b>${rub(center.net)}</b></div>
        <div title="Второй KPI отдела — ЦФО на машино-день"><span class="l">₽ ${MD_LABEL[center.key] || ''}</span>
          <b>${center.perMd == null ? '—' : rub(center.perMd)}</b><small>${center.md} МД</small></div>
        <div><span class="l">Статьи наполнены</span><b>${center.filled}/${center.articles.length}</b></div>
      </div>
    </div>
    <div class="sec-b flush"><table class="bi-table"><thead><tr><th>Статья</th><th class="r">Без НДС</th></tr></thead>
      <tbody>${articleRows(center) || '<tr><td colspan=2 class="muted">статей нет</td></tr>'}</tbody></table></div>
  </section>`;
}

function logCenter(center) {
  const r = center.result;
  const l = center.losses;
  const inc = l.incidents || {};
  return `<section class="section s6 dept-log cfo-c">
    <div class="sec-h"><span class="st">${escapeHtml(center.name)}</span>
      <span class="owner-chip chip-log">${center.coef}</span><span class="hint">${center.cls}</span></div>
    <div class="sec-b">
      <div class="cfo-own muted">${center.owners.map(owner =>
    `${escapeHtml(owner.title)}${owner.people.length ? `: ${escapeHtml(owner.people.join(', '))}` : ' — вакансия'}`).join(' · ') || 'владелец не отмечен в «Структуре»'}</div>
      <div class="cfo-kpis">
        <div><span class="l">Выручка без НДС</span><b>${mln(r.revenue)} млн</b></div>
        <div title="Второй KPI логистики"><span class="l">Выручка на МД под грузом</span><b>${rub(r.revenuePerMd)}</b><small>${r.workDays} МД</small></div>
        <div><span class="l">Маржа на МД под грузом</span><b>${rub(r.marginPerMd)}</b></div>
        <div><span class="l">Ставка, ₽/км гружёный</span><b>${r.ratePerKm ?? '—'}</b></div>
      </div>
    </div>
    <div class="sec-b flush"><table class="bi-table"><thead><tr><th>Управляемые потери</th><th class="r">Период</th></tr></thead><tbody>
      <tr><td>Порожний пробег <small class="muted">${l.emptyKm != null ? `${Math.round(l.emptyKm).toLocaleString('ru-RU')} км × переменная себестоимость` : ''}</small></td><td class="num">${rub(l.emptyCost)}</td></tr>
      <tr><td>Простой у клиента — претензии выставлены</td><td class="num">${rub(l.demurrageBilled)}</td></tr>
      <tr><td>Простой у клиента — <b>ждут выставления</b></td><td class="num">${rub(l.demurrageOpen)}</td></tr>
      <tr><td>Внештатки: акты · возвраты · опоздания</td><td class="num">${inc.act || 0} · ${inc.return || 0} · ${inc.late || 0}</td></tr>
    </tbody></table></div>
  </section>`;
}

export async function renderCfo(container, context) {
  const { state } = context;
  const today = new Date().toISOString().slice(0, 10);
  const from = state.cfoFrom || `${today.slice(0, 7)}-01`;
  const to = state.cfoTo || today;
  let data;
  try {
    data = await api(`/api/cfo?from=${from}&to=${to}`);
  } catch (error) {
    container.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    return;
  }
  const t = data.total;
  container.innerHTML = `<div class="bi-page cfo-page">
    <div class="bi-sub"><h2>${data.scope.all ? 'ЦФО направления СТ' : `Затраты ЦФО · ${escapeHtml(data.centers[0]?.name || '')}`}</h2>
      <p>Факт — журнал «Затрат» без НДС (Dornet, РН-Карт, импорт, ручной ввод), ${ruDay(data.from)}–${ruDay(data.to)}.
        Статья без записей помечена «не вносится» — норматив её не подменяет.</p>
      <div class="bi-actions"><span class="cfo-period"><input type="date" id="cfoFrom" value="${from}"> — <input type="date" id="cfoTo" value="${to}"></span></div></div>
    ${t ? `<div class="bi-kpis">
      <div class="metric dept-staff hero"><span class="l">Прибыль по учтённому</span><span class="v">${mln(t.profit)}<small>млн</small></span>
        <span class="d">выручка ${mln(t.revenue)} − затраты журнала ${mln(t.costs)}</span></div>
      ${t.byCfo.map(row => `<div class="metric dept-${row.key}"><span class="l">ЦФО · ${escapeHtml(data.centers.find(c => c.key === row.key)?.name || row.key)}</span>
        <span class="v">${mln(row.net)}<small>млн</small></span></div>`).join('')}
      <div class="metric ${t.coverage.filled < t.coverage.total ? 'warn' : ''}"><span class="l">Покрытие статей</span>
        <span class="v">${t.coverage.filled}<small>из ${t.coverage.total}</small></span>
        <span class="d">${t.normative ? `норматив: опер. прибыль ${mln(t.normative.operationalProfit)} млн` : ''}</span></div>
    </div>` : ''}
    <div class="bi-grid">${data.centers.map(center => center.key === 'log' ? logCenter(center) : costCenter(center)).join('')}</div>
  </div>`;
  const reload = () => renderCfo(container, context);
  container.querySelector('#cfoFrom').onchange = event => { state.cfoFrom = event.currentTarget.value; reload(); };
  container.querySelector('#cfoTo').onchange = event => { state.cfoTo = event.currentTarget.value; reload(); };
}
