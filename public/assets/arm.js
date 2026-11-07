// «🧭 Моё рабочее место» (АРМ, проект «Слияние», план docs/merger/08-arm.md).
// Каркас один для всех: шапка + четыре зоны в одном порядке — Анализ,
// План, Выполнение, Задачи. Наполнение приходит с сервера по реестру
// должности (src/arm.mjs); здесь — отрисовка трёх видов элементов
// (показатель, строка очереди, задача) и задачи Э2: поставить, взять,
// сделано / не сделано, снять; руководитель смотрит место подчинённого.
import { api, escapeHtml, renderInto, toast } from './api.js';

const ZONE_ICON = { analysis: '◔', plan: '▦', exec: '▶', tasks: '☑' };
const ZONE_HINT = { analysis: 'мои показатели', plan: 'сегодня · завтра', exec: 'сейчас', tasks: 'на мне' };
const ACTION_LABEL = { take: '▶ Беру', done: '✓ Сделано', fail: '✗ Не сделано', cancel: '✕ Снять' };
const num = value => value == null ? '—' : Number(value).toLocaleString('ru-RU', { maximumFractionDigits: 1 });
const go = screen => screen ? `<button class="link-btn arm-go" data-goto="${escapeHtml(screen)}" title="Открыть рабочий экран">→</button>` : '';

const metric = item => `<div class="metric ${item.tone || ''}" title="${escapeHtml(item.source || '')}">
  <span class="l">${escapeHtml(item.label)}</span>
  <span class="v">${num(item.value)}${item.unit ? `<small>${escapeHtml(item.unit)}</small>` : ''}</span>
  ${item.note ? `<span class="d">${escapeHtml(item.note)}</span>` : ''}</div>`;

const row = item => `<div class="arm-row ${item.tone || ''}" title="${escapeHtml(item.source || '')}">
  <span class="arm-l">${escapeHtml(item.label)}${item.note ? `<small class="muted"> · ${escapeHtml(item.note)}</small>` : ''}</span>
  <b class="arm-v">${num(item.value)}</b>${go(item.screen)}</div>`;

const task = item => `<div class="arm-task ${item.tone || ''}" title="${escapeHtml(item.source || '')}">
  <span class="arm-l">${escapeHtml(item.label)}${item.about ? `<small class="muted"> · ${escapeHtml(item.about)}</small>` : ''}
    ${item.body ? `<div class="muted arm-body">${escapeHtml(item.body)}</div>` : ''}</span>
  <span class="bi-tag ${item.tone || ''}">${escapeHtml(item.tag || '')}</span>
  ${(item.actions || []).map(action => `<button type="button" class="button small ${action === 'done' ? 'primary' : 'ghost'}"
    data-arm-act="${action}" data-arm-task="${escapeHtml(item.id)}">${ACTION_LABEL[action]}</button>`).join('')}${go(item.screen)}</div>`;

function zoneHtml(zone, title, items, data) {
  const metrics = items.filter(item => item.kind === 'metric');
  const rest = items.filter(item => item.kind !== 'metric');
  const empty = zone === 'tasks' ? 'Открытых задач нет' : (data.pendingNote ? 'Наполнение по должности — на следующем этапе' : 'Нет данных');
  return `<section class="section s6 arm-zone arm-${zone}">
    <div class="sec-h"><span class="sn">${ZONE_ICON[zone]}</span><span class="st">${escapeHtml(title)}</span>
      <span class="hint">${ZONE_HINT[zone]}</span>
      ${zone === 'tasks' && !data.readOnly ? '<div class="sec-actions"><button type="button" class="button small" id="armNewTask">＋ Поставить задачу</button></div>' : ''}</div>
    <div class="sec-b">
      ${metrics.length ? `<div class="bi-kpis arm-kpis">${metrics.map(metric).join('')}</div>` : ''}
      ${rest.map(item => item.kind === 'task' ? task(item) : row(item)).join('')}
      ${!items.length ? `<div class="bi-empty">${empty}</div>` : ''}
      ${zone === 'tasks' && data.given?.length ? `<div class="arm-sub">Я поставил · открыто ${data.given.length}</div>${data.given.map(task).join('')}` : ''}
    </div></section>`;
}

async function newTaskDialog(context, after) {
  let people;
  try { people = (await api('/api/arm/people')).people; } catch (error) { toast(error.message); return; }
  if (!people.length) { toast('Некому поставить задачу: в вашем отделе пока нет коллег с учётной записью'); return; }
  const tomorrow = new Date(Date.now() + 27 * 3_600_000).toISOString().slice(0, 16);
  context.showModal(`<form id="armTaskForm"><h2>☑ Поставить задачу</h2>
    <label class="field">Кому <select name="toUserId" required><option value="">—</option>${people.map(person =>
    `<option value="${escapeHtml(person.id)}">${escapeHtml(person.name)}${person.position ? ` · ${escapeHtml(person.position)}` : ''}</option>`).join('')}</select></label>
    <label class="field">Что сделать <input name="title" maxlength="300" required placeholder="Закрыть брони Корса до вечера"></label>
    <label class="field">Срок <input type="datetime-local" name="dueAt" value="${tomorrow}" required></label>
    <label class="field">К чему относится <small class="muted">рейс, машина, клиент — по желанию</small><input name="about" maxlength="200"></label>
    <label class="field">Подробности <textarea name="body" rows="3"></textarea></label>
    <p class="muted">Задачу можно поставить коллеге своего отдела. Между отделами — стыки и «⚑ Сигнал».</p>
    <div class="form-error" id="armTaskErr"></div>
    <div class="modal-actions"><button type="button" class="button ghost" data-close>Отмена</button><button class="button primary">Поставить</button></div></form>`);
  document.querySelector('#armTaskForm').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const body = Object.fromEntries(['toUserId', 'title', 'about', 'body'].map(key => [key, form[key].value]));
    body.dueAt = form.dueAt.value ? new Date(form.dueAt.value).toISOString() : '';
    try {
      await api('/api/arm/tasks', { method: 'POST', body: JSON.stringify(body) });
      context.closeModal(); toast('Задача поставлена — исполнитель получил уведомление'); after();
    } catch (error) { document.querySelector('#armTaskErr').textContent = error.message; }
  });
}

async function taskAct(id, action, after) {
  let result = '';
  if (action === 'fail') {
    result = prompt('Почему не сделано? (обязательно)') || '';
    if (!result.trim()) return;
  } else if (action === 'done') {
    result = prompt('Результат (по желанию)') ?? null;
    if (result === null) return;
  } else if (action === 'cancel' && !confirm('Снять задачу? Исполнитель получит уведомление.')) return;
  try {
    await api(`/api/arm/tasks/${encodeURIComponent(id)}`, { method: 'POST', body: JSON.stringify({ action, result }) });
    toast({ take: 'Взято в работу', done: 'Отмечено: сделано', fail: 'Отмечено: не сделано', cancel: 'Задача снята' }[action]);
    after();
  } catch (error) { toast(error.message); }
}

export async function renderArm(container, context) {
  const { state } = context;
  let data;
  let people = [];
  try {
    data = await api(`/api/arm${state.armUser ? `?user=${encodeURIComponent(state.armUser)}` : ''}`);
    const list = await api('/api/arm/people').catch(() => ({ people: [], canViewOthers: false }));
    if (list.canViewOthers) people = list.people.filter(person => person.canView);
  } catch (error) {
    container.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    return;
  }
  const p = data.person;
  const rerender = () => renderArm(container, context);
  if (!renderInto(container, `<div class="bi-page arm-page">
    <div class="section arm-head dept-${escapeHtml(p.dept)}">
      <div><div class="arm-name">${escapeHtml(p.name)}${p.position ? ` · ${escapeHtml(p.position)}` : ''}</div>
        <div class="muted">${escapeHtml([p.deptName, p.shift].filter(Boolean).join(' · '))}</div>
        ${p.deptTask ? `<div class="arm-task-dept">Задача отдела: ${escapeHtml(p.deptTask)}</div>` : ''}
        ${data.readOnly ? '<div class="bi-tag warn arm-ro">глазами сотрудника · только просмотр</div>' : ''}</div>
      ${people.length ? `<label class="arm-who">Чьё место <select id="armWho"><option value="">моё</option>${people.map(person =>
    `<option value="${escapeHtml(person.id)}" ${person.id === state.armUser ? 'selected' : ''}>${escapeHtml(person.name)}${person.position ? ` · ${escapeHtml(person.position)}` : ''}</option>`).join('')}</select></label>` : ''}
    </div>
    ${data.pendingNote ? `<div class="muted arm-pending">${escapeHtml(data.pendingNote)}</div>` : ''}
    <div class="bi-grid arm-grid">${Object.keys(data.zones).map(zone => zoneHtml(zone, data.zoneTitles[zone], data.zones[zone], data)).join('')}</div>
  </div>`)) return;
  container.querySelector('#armWho')?.addEventListener('change', event => { state.armUser = event.currentTarget.value; rerender(); });
  container.onclick = event => {
    const goto = event.target.closest('[data-goto]');
    if (goto) { document.querySelector(`#viewTabs [data-view="${goto.dataset.goto}"]`)?.click(); return; }
    const act = event.target.closest('[data-arm-act]');
    if (act) { taskAct(act.dataset.armTask, act.dataset.armAct, rerender); return; }
    if (event.target.closest('#armNewTask')) newTaskDialog(context, rerender);
  };
}
