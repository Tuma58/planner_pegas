// «◉ Моё поле» — поле управления руководителя отдела (проект «Слияние»,
// Э1, 07.11.2026). Первый экран руководителя при входе: всё о СВОЁМ
// отделе на одном экране, каждая секция ведёт в рабочий экран. Штаб
// (область «всё направление») переключает отдел и видит ровно то же
// поле, что его руководитель.
import { api, escapeHtml } from './api.js';

const DEPT_TABS = [['log', 'Логистика'], ['drv', 'Эксплуатация'], ['toir', 'ТОиР']];
const TONE = { ok: 'pos', near: 'warn', miss: 'neg' };
const pct = value => value == null ? '—' : `${String(value).replace('.', ',')}%`;
const rub = value => value == null ? '—' : `${Math.round(value).toLocaleString('ru-RU')} ₽`;
const num = (value, unit) => value == null ? '—'
  : `${Number(value).toLocaleString('ru-RU', { maximumFractionDigits: unit === '%' || unit === 'сут' ? 1 : 0 })}${unit === '%' ? '%' : ` ${unit}`}`;
const go = screen => screen ? `<button class="link-btn fd-go" data-goto="${screen}" title="Открыть рабочий экран">→</button>` : '';
const toneOf = (value, target) => value == null || target == null ? '' : value >= target ? 'pos' : value >= target - 3 ? 'warn' : 'neg';

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
        ${joint.items?.length ? `<div class="fd-plates">${joint.items.map(item =>
    `<span class="bi-tag">${escapeHtml(item.plate)}${item.hours != null ? ` · ${Math.round(item.hours)} ч` : ''}</span>`).join('')}</div>` : ''}`}
    </div>`;

  container.innerHTML = `<div class="bi-page fd-page">
    <div class="bi-sub"><h2>Моё поле · ${escapeHtml(data.name)}</h2>
      <p>Коэффициент, потери, задачи и деньги — за выбранный месяц; стыки и очереди — сейчас. Стрелка «→» — в рабочий экран.</p>
      <div class="bi-actions"><input type="month" id="fdMonth" value="${escapeHtml(data.month)}" title="Месяц показателей; очереди и стыки — всегда «сейчас»">
        ${data.canSwitch ? `<span class="segmented">${DEPT_TABS.map(([key, label]) =>
    `<button data-fd-dept="${key}" class="${data.dept === key ? 'active' : ''}">${label}</button>`).join('')}</span>` : ''}</div></div>
    <div class="bi-kpis">
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
    </div>
    <div class="bi-grid">
      <section class="section s6 dept-${data.dept}">
        <div class="sec-h"><span class="st">Стыки с соседями</span><span class="hint">процессы «Рабочей среды СТ»: мерим, что висит на передаче</span></div>
        <div class="sec-b fd-list">${data.joints.map(jointRow).join('') || '<div class="bi-empty">стыков нет</div>'}</div>
      </section>
      <section class="section s6 dept-${data.dept}">
        <div class="sec-h"><span class="st">Очереди сейчас</span><span class="hint">живые списки рабочих экранов</span></div>
        <div class="sec-b flush"><table class="bi-table"><tbody>${data.queues.map(queue => `<tr>
          <td>${escapeHtml(queue.label)}${queue.note ? `<div class="muted fd-note">${escapeHtml(queue.note)}</div>` : ''}</td>
          <td class="num"><b class="${queue.count ? 'fd-warn' : 'fd-ok'}">${queue.count}</b></td><td>${go(queue.screen)}</td></tr>`).join('')
    || '<tr><td class="muted">очередей нет</td></tr>'}</tbody></table></div>
      </section>
      <section class="section s6 dept-${data.dept}">
        <div class="sec-h"><span class="st">Задачи отдела</span><span class="hint">из «Целей и задач»</span>${go('goals')}</div>
        <div class="sec-b fd-list">${data.tasks.map(task => `<div class="fd-task ${task.kind === 'dept' ? 'goal' : ''}">
          <span>${escapeHtml(task.title)}</span>
          ${task.metric?.pending ? `<small class="muted">◌ нет источника · «${escapeHtml(task.metric.pending)}»</small>`
    : task.metric ? `<small class="fd-m ${TONE[task.metric.tone] || ''}"><b>${num(task.metric.value, task.metric.unit)}</b>${task.metric.target != null ? ` / цель ${num(task.metric.target, task.metric.unit)}` : ''}</small>` : ''}
          </div>`).join('') || '<div class="bi-empty">задач нет</div>'}</div>
      </section>
      <section class="section s6 dept-${data.dept}">
        <div class="sec-h"><span class="st">Ход коэффициента по неделям</span><span class="hint">цель ${pct(c.target)}</span></div>
        <div class="sec-b"><div class="fd-weeks">${weeks.map(week => `<div class="fd-week" title="${escapeHtml(week.from)}: ${pct(week.value)}">
          <i class="${toneOf(week.value, c.target)}" style="height:${Math.max(4, week.value / maxWeek * 100)}%"></i>
          <small>${escapeHtml(week.from.slice(8, 10))}.${escapeHtml(week.from.slice(5, 7))}</small></div>`).join('') || '<div class="bi-empty">нет данных за период</div>'}</div></div>
      </section>
      ${data.people ? `<section class="section s6 dept-${data.dept}">
        <div class="sec-h"><span class="st">Люди отдела</span>${go('structure')}</div>
        <div class="sec-b fd-list">
          <div><span class="muted">Вакансии:</span> ${data.people.openPositions.length ? data.people.openPositions.map(item =>
    `${escapeHtml(item.title)} <b>−${item.vacancies}</b>`).join(' · ') : 'нет'}</div>
          <div><span class="muted">Сегодня на смене:</span> ${data.people.onShift.length ? data.people.onShift.map(person =>
    `${escapeHtml(person.name)} <small class="muted">${person.kind === 'night' ? 'ночь' : 'день'}</small>`).join(', ') : 'график смен не заполнен'}</div>
          <div><span class="muted">Без роли в планере:</span> ${data.people.noRole}</div>
        </div></section>` : ''}
      ${money ? `<section class="section s6 dept-${data.dept}">
        <div class="sec-h"><span class="st">Деньги отдела (ЦФО)</span>${go('cfo')}</div>
        <div class="sec-b flush"><table class="bi-table"><tbody>${money.result
    ? `<tr><td>Выручка без НДС</td><td class="num">${rub(money.result.revenue)}</td></tr>
       <tr><td>Порожний пробег</td><td class="num">${rub(money.losses?.emptyCost)}</td></tr>
       <tr><td>Простой у клиента — ждут выставления</td><td class="num">${rub(money.losses?.demurrageOpen)}</td></tr>`
    : money.articles.slice(0, 6).map(item => `<tr><td>${escapeHtml(item.name)}</td>
        <td class="num">${item.count ? rub(item.net) : '<span class="muted">не вносится</span>'}</td></tr>`).join('')}</tbody></table></div>
      </section>` : ''}
      ${data.initiatives ? `<section class="section s6 dept-${data.dept}">
        <div class="sec-h"><span class="st">Инициативы отдела</span></div>
        <div class="sec-b fd-list"><div>Проект «160 млн» — открыто <b>${data.initiatives.p160}</b></div>
          <div>План «Повышения эффективности» — не выполнено <b>${data.initiatives.eff}</b></div></div>
      </section>` : ''}
    </div>
  </div>`;

  container.querySelector('#fdMonth').onchange = event => {
    state.fieldMonth = event.currentTarget.value || null;
    renderField(container, context);
  };
  container.onclick = event => {
    const switcher = event.target.closest('[data-fd-dept]');
    if (switcher) { state.fieldDept = switcher.dataset.fdDept; renderField(container, context); return; }
    const goto = event.target.closest('[data-goto]');
    if (goto) document.querySelector(`#viewTabs [data-view="${goto.dataset.goto}"]`)?.click();
  };
}

const FIELD_COEF = { log: 'КИП — с заданием от укомплектованных', drv: 'КВЛ — укомплектованные от исправных',
  toir: 'КТГ — исправные от списка', staff: 'КЭИП — использование парка' };
