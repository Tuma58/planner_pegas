// «◉ Моё поле» — поле управления руководителя отдела (проект «Слияние»,
// Э1, 07.11.2026). Первый экран руководителя при входе: всё о СВОЁМ
// отделе на одном экране, каждая секция ведёт в рабочий экран. Штаб
// (область «всё направление») переключает отдел и видит ровно то же
// поле, что его руководитель.
import { api, escapeHtml, toast } from './api.js';
import { kpiCard } from './kpi.js';
import { turnoverSection } from './turnover.js';

const DEPT_TABS = [['direction', 'Направление'], ['log', 'Логистика'], ['drv', 'Эксплуатация'], ['toir', 'ТОиР']];
const TONE = { ok: 'pos', near: 'warn', miss: 'neg' };
const pct = value => value == null ? '—' : `${String(value).replace('.', ',')}%`;
const rub = value => value == null ? '—' : `${Math.round(value).toLocaleString('ru-RU')} ₽`;
const num = (value, unit) => value == null ? '—'
  : `${Number(value).toLocaleString('ru-RU', { maximumFractionDigits: unit === '%' || unit === 'сут' ? 1 : 0 })}${unit === '%' ? '%' : ` ${unit}`}`;
const go = screen => screen ? `<button class="link-btn fd-go" data-goto="${screen}" title="Открыть рабочий экран">→</button>` : '';
const toneOf = (value, target) => value == null || target == null ? '' : value >= target ? 'pos' : value >= target - 3 ? 'warn' : 'neg';

// Секции поля — одна функция для экрана поля и для АРМ руководителя
// (Э4, 07.11): одни и те же стыки, сигналы, очереди и задачи отдела.
export const FIELD_ORDER = ['joints', 'kpi', 'leading', 'queues', 'tasks', 'weeks', 'people', 'money', 'initiatives'];
export function fieldParts(data) {
  const c = data.coef;
  const s = data.summary || { ok: 0, near: 0, miss: 0, info: 0, none: 0 };
  const money = data.money;
  const weeks = c.weeks.filter(week => week.value != null);
  const maxWeek = Math.max(100, ...weeks.map(week => week.value));

  const jointRow = joint => `<div class="fd-joint ${joint.side === 'in' ? 'in' : 'out'}">
      <div class="fd-jh"><span class="bi-tag">${joint.side === 'in' ? '⇠ получаю' : joint.side === 'out' ? '⇢ передаю' : 'стык'}</span>
        <b>«${escapeHtml(joint.risk)}»</b> ${go(joint.screen)}</div>
      ${joint.pending ? `<div class="muted">◌ нет источника — блок «${escapeHtml(joint.pending)}»</div>`
    : `<div class="fd-jv"><b class="${joint.count ? 'fd-warn' : 'fd-ok'}">${joint.count}</b> ${escapeHtml(joint.label)}
          ${joint.maxH != null && joint.count ? `<span class="muted">· дольше всех ${joint.maxH} ч</span>` : ''}</div>
        ${joint.items?.length ? `<div class="fd-cases">${joint.items.map(item => caseRow(joint, item)).join('')}</div>` : ''}`}
    </div>`;

  const leading = data.leading || [];
  return {
    tiles: `    <div class="bi-kpis">
      <div class="metric hero dept-${data.dept} ${toneOf(c.value, c.target)}"><span class="l">${escapeHtml(FIELD_COEF[data.dept])}</span>
        <span class="v">${pct(c.value)}</span><span class="d">цель ${pct(c.target)}</span></div>
      <div class="metric ${data.machineDays.lost ? 'warn' : 'pos'}"><span class="l">Потери машино-дней</span>
        <span class="v">${Math.round(data.machineDays.lost)}<small>МД</small></span><span class="d">${escapeHtml(data.machineDays.label)}</span></div>
      <div class="metric ${s.miss ? 'neg' : s.near ? 'warn' : 'pos'}"><span class="l">Задачи отдела</span>
        <span class="v">${s.ok}<small>в норме</small></span><span class="d">близко ${s.near} · мимо ${s.miss} · справочно ${s.info}</span></div>
      ${data.people ? `<div class="metric ${data.people.vacancies ? 'warn' : ''}"><span class="l">Люди</span>
        <span class="v">${data.people.fact}<small>из ${data.people.headcount}</small></span>
        <span class="d">${data.people.vacancies ? `вакансий ${data.people.vacancies}` : 'укомплектовано'} · на смене ${data.people.onShift.length}</span></div>` : ''}
      ${money ? (money.result ? `<div class="metric dept-log"><span class="l">Выручка на МД под грузом</span>
        <span class="v">${Math.round(money.result.revenuePerMd || 0).toLocaleString('ru-RU')}<small>₽</small></span>
        <span class="d">маржа ${rub(money.result.marginPerMd)} · ${money.result.workDays} МД</span></div>`
    : `<div class="metric dept-${data.dept}"><span class="l">Затраты ЦФО на МД</span>
        <span class="v">${money.perMd == null ? '—' : Math.round(money.perMd).toLocaleString('ru-RU')}<small>₽</small></span>
        <span class="d">за период ${rub(money.net)} · статей ${money.filled}/${money.articles.length}</span></div>`) : ''}
    </div>`,
    joints: `<section class="section s6 dept-${data.dept}">
        <div class="sec-h"><span class="st">Стыки с соседями</span><span class="hint">процессы «Рабочей среды СТ»: мерим, что висит на передаче</span></div>
        <div class="sec-b fd-list">${data.joints.map(jointRow).join('') || '<div class="bi-empty">стыков нет</div>'}</div>
      </section>`,
    kpi: data.kpi ? kpiCard(data.kpi, { compact: true }) : '',
    leading: leading.length ? leadingSection(leading, data.dept) : '',
    queues: `<section class="section s6 dept-${data.dept}">
        <div class="sec-h"><span class="st">Очереди сейчас</span><span class="hint">живые списки рабочих экранов</span></div>
        <div class="sec-b flush"><table class="bi-table"><tbody>${data.queues.map(queue => `<tr>
          <td>${escapeHtml(queue.label)}${queue.note ? `<div class="muted fd-note">${escapeHtml(queue.note)}</div>` : ''}</td>
          <td class="num"><b class="${queue.count ? 'fd-warn' : 'fd-ok'}">${queue.count}</b></td><td>${go(queue.screen)}</td></tr>`).join('')
    || '<tr><td class="muted">очередей нет</td></tr>'}</tbody></table></div>
      </section>`,
    tasks: `<section class="section s6 dept-${data.dept}">
        <div class="sec-h"><span class="st">Задачи отдела</span><span class="hint">из «Целей и задач»</span>${go('goals')}</div>
        <div class="sec-b fd-list">${data.tasks.map(task => `<div class="fd-task ${task.kind === 'dept' ? 'goal' : ''}">
          <span>${escapeHtml(task.title)}</span>
          ${task.metric?.pending ? `<small class="muted">◌ нет источника · «${escapeHtml(task.metric.pending)}»</small>`
    : task.metric ? `<small class="fd-m ${TONE[task.metric.tone] || ''}"><b>${num(task.metric.value, task.metric.unit)}</b>${task.metric.target != null ? ` / цель ${num(task.metric.target, task.metric.unit)}` : ''}</small>` : ''}
          </div>`).join('') || '<div class="bi-empty">задач нет</div>'}</div>
      </section>`,
    weeks: `<section class="section s6 dept-${data.dept}">
        <div class="sec-h"><span class="st">Ход коэффициента по неделям</span><span class="hint">цель ${pct(c.target)}</span></div>
        <div class="sec-b"><div class="fd-weeks">${weeks.map(week => `<div class="fd-week" title="${escapeHtml(week.from)}: ${pct(week.value)}">
          <i class="${toneOf(week.value, c.target)}" style="height:${Math.max(4, week.value / maxWeek * 100)}%"></i>
          <small>${escapeHtml(week.from.slice(8, 10))}.${escapeHtml(week.from.slice(5, 7))}</small></div>`).join('') || '<div class="bi-empty">нет данных за период</div>'}</div></div>
      </section>`,
    people: data.people ? `<section class="section s6 dept-${data.dept}">
        <div class="sec-h"><span class="st">Люди отдела</span>${go('structure')}</div>
        <div class="sec-b fd-list">
          <div><span class="muted">Вакансии:</span> ${data.people.openPositions.length ? data.people.openPositions.map(item =>
    `${escapeHtml(item.title)} <b>−${item.vacancies}</b>`).join(' · ') : 'нет'}</div>
          <div><span class="muted">Сегодня на смене:</span> ${data.people.onShift.length ? data.people.onShift.map(person =>
    `${escapeHtml(person.name)} <small class="muted">${person.kind === 'night' ? 'ночь' : 'день'}</small>`).join(', ') : 'график смен не заполнен'}</div>
          <div><span class="muted">Без роли в планере:</span> ${data.people.noRole}</div>
        </div></section>` : '',
    money: money ? `<section class="section s6 dept-${data.dept}">
        <div class="sec-h"><span class="st">Деньги отдела (ЦФО)</span>${go('cfo')}</div>
        <div class="sec-b flush"><table class="bi-table"><tbody>${money.result
    ? `<tr><td>Выручка без НДС</td><td class="num">${rub(money.result.revenue)}</td></tr>
       <tr><td>Порожний пробег</td><td class="num">${rub(money.losses?.emptyCost)}</td></tr>
       <tr><td>Простой у клиента — ждут выставления</td><td class="num">${rub(money.losses?.demurrageOpen)}</td></tr>`
    : money.articles.slice(0, 6).map(item => `<tr><td>${escapeHtml(item.name)}</td>
        <td class="num">${item.count ? rub(item.net) : '<span class="muted">не вносится</span>'}</td></tr>`).join('')}</tbody></table></div>
      </section>` : '',
    initiatives: data.initiatives ? `<section class="section s6 dept-${data.dept}">
        <div class="sec-h"><span class="st">Инициативы отдела</span></div>
        <div class="sec-b fd-list"><div>Проект «160 млн» — открыто <b>${data.initiatives.p160}</b></div>
          <div>План «Повышения эффективности» — не выполнено <b>${data.initiatives.eff}</b></div></div>
      </section>` : '',
  };
}

export async function renderField(container, context) {
  const { state } = context;
  let data;
  try {
    const query = new URLSearchParams();
    if (state.fieldDept) query.set('dept', state.fieldDept);
    if (state.fieldMonth) query.set('month', state.fieldMonth);
    data = await api(`/api/field?${query}`);
  } catch (error) {
    container.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    return;
  }
  if (data.direction) { renderDirection(container, context, data); return; }
  const parts = fieldParts(data);
  container.innerHTML = `<div class="bi-page fd-page">
    <div class="bi-sub"><h2>${data.canSwitch ? 'Поле отдела' : 'Моё поле'} · ${escapeHtml(data.name)}</h2>
      <p>Коэффициент, потери, задачи и деньги — за выбранный месяц; стыки и очереди — сейчас. Стрелка «→» — в рабочий экран.</p>
      <div class="bi-actions"><input type="month" id="fdMonth" value="${escapeHtml(data.month)}" title="Месяц показателей; очереди и стыки — всегда «сейчас»">
        ${data.canSwitch ? tabsHtml(data.dept) : ''}</div></div>
    ${parts.tiles}
    <div class="bi-grid">${FIELD_ORDER.map(key => parts[key] || '').join('')}</div>
  </div>`;

  container.querySelector('#fdMonth').onchange = event => {
    state.fieldMonth = event.currentTarget.value || null;
    renderField(container, context);
  };
  container.onclick = event => fieldClick(event, container, context);
  // Текучесть водителей — KPI паспорта руководителя эксплуатации (чек-лист
  // Б1.3): за выбранный месяц, догружается отдельно, поле не ждёт.
  if (data.dept === 'drv') {
    const from = `${data.month}-01`;
    const last = new Date(Date.UTC(Number(data.month.slice(0, 4)), Number(data.month.slice(5, 7)), 0)).toISOString().slice(0, 10);
    const today = new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
    api(`/api/turnover?from=${from}&to=${last < today ? last : today}`).then(turnover => {
      container.querySelector('.fd-page .bi-grid')?.insertAdjacentHTML('beforeend', turnoverSection(turnover));
    }).catch(() => { /* нет права или данных — секции нет */ });
  }
}

// Кнопки сквозного контроля (блок 4): контролёр — «⚑ Сигнал», владелец —
// «✓ Принять»; случай закрывается сам, когда устранено.
// Клики поля: используются и экраном поля, и АРМ руководителя
// (context.rerender — перерисовать АРМ после сигнала).
export async function fieldClick(event, container, context) {
  const { state } = context;
  const switcher = event.target.closest('[data-fd-dept]');
  if (switcher) { state.fieldDept = switcher.dataset.fdDept; renderField(container, context); return; }
  const goto = event.target.closest('[data-goto]');
  if (goto) { document.querySelector(`#viewTabs [data-view="${goto.dataset.goto}"]`)?.click(); return; }
  const action = event.target.closest('[data-signal]');
  if (!action) return;
  action.disabled = true;
  try {
    await api(`/api/signals/${action.dataset.signal}/${action.dataset.act}`, { method: 'POST' });
    toast(action.dataset.act === 'raise' ? 'Сигнал подан — владелец стыка получил уведомление' : 'Сигнал принят');
    if (context.rerender) context.rerender(); else renderField(container, context);
  } catch (error) { toast(error.message); action.disabled = false; }
}

function caseRow(joint, item) {
  const hours = item.hours != null ? `${Math.round(item.hours)} ч` : '';
  if (!item.id) return `<span class="bi-tag">${escapeHtml(item.plate)}${hours ? ` · ${hours}` : ''}</span>`;
  const state = item.acceptedAt ? `<span class="bi-tag pos" title="Принял ${escapeHtml(item.acceptedBy)}">✓ принято</span>`
    : item.signaledAt ? `<span class="bi-tag warn" title="Подал ${escapeHtml(item.signaledBy)}">⚑ сигнал подан</span>`
      : '<span class="bi-tag neg">сигнала нет</span>';
  const button = !item.signaledAt && joint.canSignal
    ? `<button class="button small" data-signal="${item.id}" data-act="raise" title="Подать сигнал отделу-владельцу: он получит уведомление">⚑ Сигнал</button>`
    : item.signaledAt && !item.acceptedAt && joint.canAccept
      ? `<button class="button small" data-signal="${item.id}" data-act="accept" title="Принять сигнал в работу">✓ Принять</button>` : '';
  return `<div class="fd-case"><b>${escapeHtml(item.plate)}</b><span class="muted">${hours}</span>${state}${button}</div>`;
}

function leadingSection(leading, dept) {
  return `<section class="section s6 dept-${dept}">
    <div class="sec-h"><span class="st">Опережающие сигналы</span><span class="hint">не дать коэффициенту упасть — до того, как он просел</span></div>
    <div class="sec-b flush"><table class="bi-table"><tbody>${leading.map(item => `<tr>
      <td><span class="owner-chip chip-${item.dept}">${escapeHtml(item.coef)}</span> ${escapeHtml(item.label)}
        ${item.note ? `<div class="muted fd-note">${escapeHtml(item.note)}</div>` : ''}</td>
      <td class="num"><b class="${item.count ? 'fd-warn' : 'fd-ok'}">${item.count}</b></td>
      <td>${go(item.screen)}</td></tr>`).join('')}</tbody></table></div>
  </section>`;
}

const tabsHtml = current => `<span class="segmented">${DEPT_TABS.map(([key, label]) =>
  `<button data-fd-dept="${key}" class="${current === key ? 'active' : ''}">${label}</button>`).join('')}</span>`;

// Поле направления (Э2, 07.11): свод Штаба и провал в поле любого отдела.
function renderDirection(container, context, data) {
  const { state } = context;
  const wf = data.waterfall;
  const calendar = wf[0]?.value || 0;
  const r = data.revenue;
  const deptCard = card => {
    const s = card.summary;
    const hanging = card.joints.filter(joint => joint.side === 'in' && joint.count);
    return `<section class="section s4 dept-${card.dept} fd-card" data-fd-dept="${card.dept}" title="Открыть поле отдела — как его видит руководитель">
      <div class="sec-h"><span class="st">${escapeHtml(card.name)}</span><span class="owner-chip chip-${card.dept}">${FIELD_SHORT[card.dept]}</span>
        <span class="fd-go" style="margin-left:auto">→</span></div>
      <div class="sec-b fd-list">
        <div class="fd-big ${toneOf(card.coef.value, card.coef.target)}"><b>${pct(card.coef.value)}</b> <span class="muted">цель ${pct(card.coef.target)}</span></div>
        <div><span class="muted">Потери:</span> <b>${Math.round(card.machineDays.lost)} МД</b> <span class="muted">· ${escapeHtml(card.machineDays.label)}</span></div>
        <div><span class="muted">Задачи:</span> в норме <b>${s.ok}</b> · близко <b>${s.near}</b> · мимо <b class="${s.miss ? 'fd-bad' : ''}">${s.miss}</b></div>
        <div><span class="muted">Очереди:</span> ${card.queues.map(queue => `${escapeHtml(queue.label)} <b class="${queue.count ? 'fd-warn' : ''}">${queue.count}</b>`).join(' · ') || '—'}</div>
        ${hanging.length ? `<div><span class="muted">Висит на входе:</span> ${hanging.map(joint => `«${escapeHtml(joint.risk)}» <b class="fd-warn">${joint.count}</b>`).join(' · ')}</div>` : ''}
        ${card.people ? `<div><span class="muted">Люди:</span> <b>${card.people.fact}</b> из ${card.people.headcount}${card.people.vacancies ? ` · вакансий <b class="fd-warn">${card.people.vacancies}</b>` : ''} · на смене ${card.people.onShift.length}</div>` : ''}
        ${card.money ? `<div><span class="muted">Деньги:</span> ${card.money.result
    ? `выручка на МД под грузом <b>${rub(card.money.result.revenuePerMd)}</b>`
    : `затраты <b>${rub(card.money.net)}</b> · на МД <b>${rub(card.money.perMd)}</b>`}</div>` : ''}
      </div></section>`;
  };
  container.innerHTML = `<div class="bi-page fd-page">
    <div class="bi-sub"><h2>Поле направления СТ</h2>
      <p>Свод отделов за месяц и стыки на текущий момент. Клик по отделу — его поле, ровно как видит руководитель отдела.</p>
      <div class="bi-actions"><input type="month" id="fdMonth" value="${escapeHtml(data.month)}">${tabsHtml('direction')}</div></div>
    <div class="bi-kpis">
      ${data.cascade.map(item => `<div class="metric ${item.coef === 'КЭИП' ? 'hero' : ''} dept-${item.dept} ${toneOf(item.value, item.target)}">
        <span class="l">${item.coef}</span><span class="v">${pct(item.value)}</span><span class="d">цель ${pct(item.target)}</span></div>`).join('')}
      ${r ? `<div class="metric dept-staff ${TONE[r.tone] || ''}"><span class="l">Выручка месяца без НДС</span>
        <span class="v">${num(r.value, '')}<small>млн</small></span><span class="d">${escapeHtml(r.note || '')}</span></div>` : ''}
    </div>
    <div class="bi-grid">
      ${data.depts.map(deptCard).join('')}
      <section class="section s6">
        <div class="sec-h"><span class="st">Машино-дни — общая валюта каскада</span><span class="hint">где теряются дни и чья это зона</span></div>
        <div class="sec-b fd-wf">${wf.length ? wf.map(step => `<div class="fd-wf-row ${step.total ? 'total' : ''}">
          <span>${escapeHtml(step.label)}</span>
          <span class="fd-wf-bar"><i class="${step.dept ? `dept-${step.dept}` : ''}" style="width:${calendar ? Math.min(100, Math.abs(step.value) / calendar * 100) : 0}%"></i></span>
          <b>${step.value > 0 && step.key !== 'calendar' && !step.total ? '+' : ''}${Math.round(step.value).toLocaleString('ru-RU')}</b></div>`).join('')
    : '<div class="bi-empty">нет данных за период</div>'}</div>
      </section>
      <section class="section s6">
        <div class="sec-h"><span class="st">Стыки между отделами</span><span class="hint">процессы среды СТ — что висит на передаче сейчас</span></div>
        <div class="sec-b fd-list">${data.joints.map(joint => `<div class="fd-joint">
          <div class="fd-jh"><span class="owner-chip chip-${joint.from}">${FIELD_SHORT[joint.from]}</span> → <span class="owner-chip chip-${joint.to}">${FIELD_SHORT[joint.to]}</span>
            <b>«${escapeHtml(joint.risk)}»</b></div>
          ${joint.pending || joint.count == null ? `<div class="muted">◌ нет источника — блок «${escapeHtml(joint.pending || 'Процессы и контроль')}»</div>`
    : `<div class="fd-jv"><b class="${joint.count ? 'fd-warn' : 'fd-ok'}">${joint.count}</b> ${escapeHtml(joint.label)}${joint.maxH != null && joint.count ? ` <span class="muted">· дольше всех ${joint.maxH} ч</span>` : ''}
          ${joint.waiting != null ? `<span class="muted">· без сигнала ${joint.waiting} · ждут принятия ${joint.signaled}</span>` : ''}</div>`}
        </div>`).join('')}</div>
      </section>
      ${data.leading?.length ? leadingSection(data.leading, 'staff') : ''}
      <section class="section s6 dept-staff">
        <div class="sec-h"><span class="st">Задачи Штаба</span>${go('goals')}</div>
        <div class="sec-b fd-list">${data.staff.tasks.map(task => `<div class="fd-task ${task.kind === 'dept' ? 'goal' : ''}">
          <span>${escapeHtml(task.title)}</span>
          ${task.metric?.pending ? `<small class="muted">◌ «${escapeHtml(task.metric.pending)}»</small>`
    : task.metric ? `<small class="fd-m ${TONE[task.metric.tone] || ''}"><b>${num(task.metric.value, task.metric.unit)}</b>${task.metric.target != null ? ` / ${num(task.metric.target, task.metric.unit)}` : ''}</small>` : ''}</div>`).join('')}</div>
      </section>
      <section class="section s6 dept-staff">
        <div class="sec-h"><span class="st">Инициативы направления</span></div>
        <div class="sec-b flush"><table class="bi-table"><thead><tr><th>Отдел</th><th class="r">«160 млн»</th><th class="r">План эффективности</th></tr></thead>
          <tbody>${['log', 'drv', 'toir', 'staff'].map(key => {
    const item = data.initiatives?.[key] || { p160: 0, eff: 0 };
    return `<tr><td>${FIELD_SHORT[key]}</td><td class="num">${item.p160}</td><td class="num">${item.eff}</td></tr>`;
  }).join('')}</tbody></table></div>
      </section>
    </div>
  </div>`;
  container.querySelector('#fdMonth').onchange = event => {
    state.fieldMonth = event.currentTarget.value || null;
    renderField(container, context);
  };
  container.onclick = event => fieldClick(event, container, context);
}

const FIELD_SHORT = { log: 'Логистика', drv: 'Эксплуатация', toir: 'ТОиР', staff: 'Штаб' };

const FIELD_COEF = { log: 'КИП — с заданием от укомплектованных', drv: 'КВЛ — укомплектованные от исправных',
  toir: 'КТГ — исправные от списка', staff: 'КЭИП — использование парка' };
