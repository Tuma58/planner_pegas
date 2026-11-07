// Экран «Цели и задачи» (проект «Слияние», блок 2, 07.11.2026): панель
// «Рабочей среды СТ», но на живых данных. Миссия и стратегические цели,
// цели и задачи отделов — у каждой живой показатель из каталога
// (src/goals.mjs) со светофором против реестра целей и переходом на экран,
// где задача решается. Тексты и привязку показателей правит руководитель.
import { api, escapeHtml, toast } from './api.js';

const DEPTS = [
  ['toir', 'Ремонтная служба (ТОиР)', 'центр затрат'],
  ['drv', 'Отдел эксплуатации', 'центр затрат'],
  ['log', 'Отдел логистики', 'центр дохода/маржи'],
  ['staff', 'Штаб / руководство', 'центр прибыли']
];
const TONE = { ok: 'pos', near: 'warn', miss: 'neg', info: '', none: '' };
const TONE_TITLE = { ok: 'в норме', near: 'близко к цели (в пределах 5%)', miss: 'мимо цели', info: 'справочно — цели нет', none: 'нет данных' };

const num = (value, unit) => {
  if (value == null) return '—';
  const digits = unit === '%' || unit === 'сут' || unit === 'млн ₽' ? 1 : 0;
  return Number(value).toLocaleString('ru-RU', { maximumFractionDigits: digits });
};
const ruDay = iso => String(iso).split('-').reverse().join('.');
const withUnit = (value, unit) => value == null ? '—' : `${num(value, unit)}${unit === '%' ? '%' : ` ${unit}`}`;

function metricLine(metric) {
  if (!metric) return '';
  if (metric.pending) {
    return `<span class="gl-m none" title="Источника в планере пока нет">◌ нет источника · блок «${escapeHtml(metric.pending)}»</span>`;
  }
  if (metric.unknown) return '<span class="gl-m none">◌ показатель не найден</span>';
  const target = metric.target != null ? ` <small>/ цель ${withUnit(metric.target, metric.unit)}</small>` : '';
  return `<span class="gl-m ${metric.tone}" title="${escapeHtml(metric.label)} · ${TONE_TITLE[metric.tone]}${metric.note ? ` · ${escapeHtml(metric.note)}` : ''}">
    <i class="gl-dot"></i><b>${withUnit(metric.value, metric.unit)}</b>${target}
    ${metric.screen ? `<button class="link-btn" data-goto="${metric.screen}" title="Открыть экран, где решается задача">→</button>` : ''}</span>`;
}

export async function renderGoals(container, context) {
  const { state } = context;
  const month = state.goalsMonth || new Date().toISOString().slice(0, 7);
  let data;
  try {
    data = await api(`/api/goals?month=${month}`);
  } catch (error) {
    container.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    return;
  }
  const edit = Boolean(state.goalsEdit && data.canEdit);
  const byKind = kind => data.items.filter(item => item.kind === kind);
  const mission = byKind('mission')[0];
  const tools = item => edit ? `<span class="gl-tools">
    <button class="link-btn" data-edit="${item.id}" title="Править текст и показатель">✎</button>
    ${item.kind === 'mission' ? '' : `<button class="link-btn" data-del="${item.id}" title="Убрать">✕</button>`}</span>` : '';
  const head = data.head.map(metric => `<div class="metric ${TONE[metric.tone] || ''}">
    <span class="l">${escapeHtml(metric.label)}</span>
    <span class="v">${num(metric.value, metric.unit)}<small>${metric.unit === '%' ? '%' : metric.unit}</small></span>
    <span class="d">${metric.target != null ? `цель ${withUnit(metric.target, metric.unit)}` : ''}${metric.note ? ` · ${escapeHtml(metric.note)}` : ''}</span></div>`).join('');
  const s = data.summary;

  container.innerHTML = `<div class="bi-page gl-page">
    <div class="bi-sub"><h2>Цели и задачи направления СТ</h2>
      <p>${mission ? `${escapeHtml(mission.body)} ${tools(mission)}` : ''}</p>
      <div class="bi-actions">
        <input type="month" id="glMonth" value="${month}" title="Месяц, за который считаются показатели">
        ${data.canEdit ? `<button class="button ${edit ? 'primary' : 'secondary'}" id="glEdit">${edit ? '✓ Готово' : '✎ Править'}</button>` : ''}
      </div></div>
    <div class="bi-kpis">${head}
      <div class="metric"><span class="l">Задачи отделов</span>
        <span class="v">${s.ok}<small>в норме</small></span>
        <span class="d">близко ${s.near} · мимо ${s.miss} · справочно ${s.info} · без источника ${s.none}</span></div>
    </div>
    <div class="bi-grid">
      <section class="section">
        <div class="sec-h"><span class="st">Стратегические цели</span>
          <span class="hint">показатели — ${ruDay(data.from)}–${ruDay(new Date(Date.parse(`${data.to}T00:00:00Z`) - 864e5).toISOString().slice(0, 10))}, цели — «⚙ Настройки → Цели направления СТ»</span>
          <div class="sec-actions">${edit ? '<button class="button ghost small" data-add="strategy">＋ цель</button>' : ''}</div></div>
        <div class="sec-b gl-strat">${byKind('strategy').map(item => `<div class="gl-card">
          <h3>${escapeHtml(item.title)} ${tools(item)}</h3>
          <p>${escapeHtml(item.body)}</p>
          <div class="gl-foot">${metricLine(item.metric)}</div></div>`).join('')}</div>
      </section>
      ${DEPTS.map(([key, name, center]) => {
    const goal = data.items.find(item => item.kind === 'dept' && item.dept === key);
    const tasks = data.items.filter(item => item.kind === 'task' && item.dept === key);
    const ini = data.initiatives?.[key] || { p160: 0, eff: 0 };
    return `<section class="section s3 dept-${key} gl-dept">
          <div class="sec-h"><span class="st">${name}</span><span class="hint">${center}</span>
            <div class="sec-actions">${edit ? `<button class="button ghost small" data-add="task" data-dept="${key}">＋ задача</button>` : ''}</div></div>
          <div class="sec-b">
            ${goal ? `<div class="gl-goal">${escapeHtml(goal.title)} ${tools(goal)}</div>
              <div class="gl-coef">${metricLine(goal.metric)}</div>` : ''}
            <ul class="gl-tasks">${tasks.map(task => `<li>
              <div class="gl-t">${escapeHtml(task.title)} ${tools(task)}</div>
              ${metricLine(task.metric)}</li>`).join('') || '<li class="bi-empty">задач нет</li>'}</ul>
            <div class="gl-ini muted" title="Открытые инициативы проекта «160 млн» и невыполненные пункты плана последнего выпуска «Повышения эффективности», отнесённые к отделу">
              в работе: «160 млн» — <b>${ini.p160}</b> · план эффективности — <b>${ini.eff}</b></div>
          </div></section>`;
  }).join('')}
      <section class="section">
        <div class="sec-h"><span class="st">Как достигаем — принципы управления</span>
          <div class="sec-actions">${edit ? '<button class="button ghost small" data-add="principle">＋ принцип</button>' : ''}</div></div>
        <div class="sec-b flush">${byKind('principle').map(item => `<div class="gl-pr">
          <b>${escapeHtml(item.title)}</b> ${tools(item)}<div class="muted">${escapeHtml(item.body)}</div></div>`).join('')}</div>
      </section>
    </div>
  </div>`;

  const rerender = () => renderGoals(container, context);
  container.querySelector('#glMonth').onchange = event => {
    state.goalsMonth = event.currentTarget.value || null;
    rerender();
  };
  const editButton = container.querySelector('#glEdit');
  if (editButton) editButton.onclick = () => { state.goalsEdit = !edit; rerender(); };
  container.onclick = async event => {
    const go = event.target.closest('[data-goto]');
    if (go) {
      document.querySelector(`#viewTabs [data-view="${go.dataset.goto}"]`)?.click();
      return;
    }
    const editItem = event.target.closest('[data-edit]');
    if (editItem) return goalDialog(context, data, data.items.find(item => item.id === editItem.dataset.edit), null, rerender);
    const add = event.target.closest('[data-add]');
    if (add) return goalDialog(context, data, null, { kind: add.dataset.add, dept: add.dataset.dept || '' }, rerender);
    const del = event.target.closest('[data-del]');
    if (del) {
      const item = data.items.find(entry => entry.id === del.dataset.del);
      if (!confirm(`Убрать «${item?.title}»?`)) return;
      try {
        await api(`/api/goals/items/${del.dataset.del}`, { method: 'DELETE' });
        toast('Убрано');
        rerender();
      } catch (error) { toast(error.message); }
    }
    return undefined;
  };
}

const KIND_TITLE = { mission: 'Миссия', strategy: 'Стратегическая цель', dept: 'Цель отдела', task: 'Задача отдела', principle: 'Принцип управления' };
const PENDING = ['Процессы и контроль', 'ФОТ', 'KPI и каскад', 'Табель аппарата'];

function goalDialog(context, data, item, fresh, after) {
  const { showModal, closeModal } = context;
  const kind = item?.kind || fresh.kind;
  const current = item?.metricKey || '';
  const withBody = kind !== 'dept' && kind !== 'task';
  showModal(`<form id="glForm"><h2>${KIND_TITLE[kind]}${item ? '' : ' · новая'}</h2>
    <label class="field">${kind === 'mission' ? 'Заголовок' : 'Текст'} <input name="title" required value="${escapeHtml(item?.title || '')}"></label>
    ${withBody ? `<label class="field">Пояснение <textarea name="body" rows="4">${escapeHtml(item?.body || '')}</textarea></label>` : ''}
    ${kind === 'principle' || kind === 'mission' ? '' : `<label class="field">Живой показатель
      <select name="metricKey"><option value="">— без показателя</option>
        ${data.metrics.map(metric => `<option value="${metric.key}" ${current === metric.key ? 'selected' : ''}>${escapeHtml(metric.label)}, ${escapeHtml(metric.unit)}</option>`).join('')}
        <optgroup label="Источника пока нет">${PENDING.map(name => `<option value="pending:${name}" ${current === `pending:${name}` ? 'selected' : ''}>появится в блоке «${name}»</option>`).join('')}</optgroup>
      </select><small class="muted">цели для светофора — из «⚙ Настройки → Цели направления СТ»</small></label>`}
    <div class="form-error" id="glFormError"></div>
    <div class="modal-actions"><button type="button" class="button ghost" data-close>Отмена</button>
      <button class="button primary">Сохранить</button></div></form>`);
  document.querySelector('#glForm').addEventListener('submit', async event => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const body = { id: item?.id, kind, dept: item?.dept || fresh?.dept || '',
      title: String(values.get('title') || '').trim(),
      body: withBody ? String(values.get('body') || '') : (item?.body || ''),
      metricKey: values.has('metricKey') ? String(values.get('metricKey') || '') : (item?.metricKey || '') };
    try {
      await api('/api/goals/items', { method: 'POST', body: JSON.stringify(body) });
      toast('Сохранено');
      closeModal(); after();
    } catch (error) { document.querySelector('#glFormError').textContent = error.message; }
  });
}
