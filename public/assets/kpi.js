// Панель «◎ KPI и каскад» (проект «Слияние», блок 4, 07.11.2026). Штаб —
// все отделы и каскад; руководитель отдела — свой отдел (сервер отдаёт
// по области). У отдела: основной KPI (машино-дни этапа), второй (ЦФО на
// машино-день), сквозной контроль соседа (бдительность сигналов) и
// устранение входящих сигналов, индекс KPI (ориентир для «ФОТ»), KPI
// должностей из паспортов с живыми значениями там, где они измеримы.
import { api, escapeHtml } from './api.js';

const pct = value => value == null ? '—' : `${String(value).replace('.', ',')}%`;
const hrs = value => value == null ? '—' : `${String(value).replace('.', ',')} ч`;
const tone = (value, target) => value == null || target == null ? '' : value >= target ? 'pos' : value >= target - 3 ? 'warn' : 'neg';
const BIND = { main: 'основной KPI', second: 'второй KPI (ЦФО)', control: 'сквозной контроль', keip: 'каскад направления',
  personal: 'личный — «Показатели сотрудников» / «Моя смена»', driver: 'водитель — Ресурс и показатели водителя', manual: 'оценка руководителя (блок «ФОТ»)' };
const JOINT = { toir_drv: '«починили — не укомплектовали»', drv_log: '«укомплектовали — не загрузили»', log_toir: '«гоняем — довели до поломки»' };

export function kpiCard(item, { compact = false, span = '' } = {}) {
  const m = item.main;
  const c = item.control;
  const o = item.owns;
  return `<section class="section ${span || (compact ? 's6' : 's4')} dept-${item.dept} kp-card">
    <div class="sec-h"><span class="st">${escapeHtml(item.name)}</span><span class="owner-chip chip-${item.dept}">${item.coef}</span>
      <span class="hint">вес: свой ${item.ownPct}% · контроль ${100 - item.ownPct}%</span></div>
    <div class="sec-b kp-rows">
      <div class="kp-index ${item.index == null ? '' : item.index >= 95 ? 'pos' : item.index >= 85 ? 'warn' : 'neg'}">
        <b>${item.index ?? '—'}</b><span>индекс KPI<br><small class="muted">ориентир для блока «ФОТ»</small></span></div>
      <div><span class="kp-l">Основной · машино-дни этапа</span>
        <b class="${tone(m.value, m.target)}">${pct(m.value)}</b> <span class="muted">цель ${pct(m.target)} · потери ${m.lostMd} МД</span></div>
      <div><span class="kp-l">Второй · ЦФО на машино-день</span>
        ${item.second ? `<b>${item.second.value == null ? '—' : `${Math.round(item.second.value).toLocaleString('ru-RU')} ₽`}</b> <span class="muted">${escapeHtml(item.second.label)} · ${escapeHtml(item.second.extra || '')}</span>`
    : '<span class="muted">виден владельцу ЦФО и Штабу</span>'}</div>
      <div><span class="kp-l">Сквозной контроль соседа · ${JOINT[c.joint]}</span>
        ${c.pending ? '<span class="muted">◌ ждёт интервалов ТО — блок «Процессы и контроль»</span>'
    : `<b class="${c.onTimePct == null ? '' : c.onTimePct >= 95 ? 'pos' : c.onTimePct >= 80 ? 'warn' : 'neg'}">${pct(c.onTimePct)}</b>
          <span class="muted">сигналов вовремя (≤ ${hrs(c.targetH)}) · случаев ${c.cases} · подано ${c.signaled} · медиана до сигнала ${hrs(c.signalMedianH)}</span>`}</div>
      <div><span class="kp-l">Устранение входящих · ${JOINT[o.joint]}</span>
        ${o.pending ? '<span class="muted">◌ ждёт интервалов ТО</span>'
    : `<b>${hrs(o.fixMedianH)}</b> <span class="muted">медиана «сигнал → устранено» · принято ${o.accepted} из ${o.signaled}</span>`}</div>
    </div>
  </section>`;
}

// KPI должностей отдела из паспортов — во всю ширину под карточками.
function positionsSection(item) {
  return `<section class="section dept-${item.dept}">
    <div class="sec-h"><span class="st">KPI должностей · ${escapeHtml(item.name)}</span>
      <span class="hint">из паспортов; живое значение — где показатель измерим в планере</span></div>
    <div class="sec-b flush"><table class="bi-table"><thead><tr><th>Должность</th><th>KPI паспорта</th><th>Норма</th><th>Сейчас / источник</th></tr></thead><tbody>
      ${item.positions.map(position => position.kpi.map((row, i) => `<tr>
        <td>${i === 0 ? `<b>${escapeHtml(position.title)}</b>` : ''}</td>
        <td>${escapeHtml(row.title)}</td>
        <td>${escapeHtml(row.norm)}</td>
        <td>${row.live ? `<b>${escapeHtml(row.live)}</b>` : `<small class="muted">${escapeHtml(BIND[row.bind] || '')}</small>`}</td></tr>`).join('')).join('')}
    </tbody></table></div>
  </section>`;
}

export async function renderKpi(container, context) {
  const { state } = context;
  let data;
  try {
    data = await api(`/api/kpi${state.kpiMonth ? `?month=${state.kpiMonth}` : ''}`);
  } catch (error) {
    container.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    return;
  }
  const t = data.targets;
  container.innerHTML = `<div class="bi-page kp-page">
    <div class="bi-sub"><h2>${data.cascade ? 'KPI и каскад направления' : `KPI · ${escapeHtml(data.depts.map(item => item.name).join(', '))}`}</h2>
      <p>У отдела два KPI — машино-дни своего этапа и ЦФО на машино-день — и сквозной контроль соседа: мерим бдительность (сигнал вовремя), а не чужую цифру.</p>
      <div class="bi-actions"><input type="month" id="kpMonth" value="${escapeHtml(data.month)}"></div></div>
    ${data.cascade ? `<div class="bi-kpis">${[['КТГ', 'ktg', 'toir'], ['КВЛ', 'kvl', 'drv'], ['КИП', 'kip', 'log'], ['КЭИП', 'koef', 'staff']]
    .map(([coef, key, dept]) => `<div class="metric ${coef === 'КЭИП' ? 'hero' : ''} dept-${dept} ${tone(data.cascade[key], t[coef])}">
      <span class="l">${coef}</span><span class="v">${pct(data.cascade[key])}</span><span class="d">цель ${pct(t[coef])}</span></div>`).join('')}</div>` : ''}
    <div class="bi-grid">${data.depts.map(item => kpiCard(item, { span: data.depts.length === 1 ? 's6' : 's4' })).join('')}
      ${data.depts.map(positionsSection).join('')}</div>
  </div>`;
  container.querySelector('#kpMonth').onchange = event => {
    state.kpiMonth = event.currentTarget.value || null;
    renderKpi(container, context);
  };
}
