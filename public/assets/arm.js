// «🧭 Моё рабочее место» (АРМ, проект «Слияние», Э1 07.11.2026, план
// docs/merger/08-arm.md). Каркас один для всех: шапка + четыре зоны в одном
// порядке — Анализ, План, Выполнение, Задачи. Наполнение приходит с
// сервера по реестру должности (src/arm.mjs); здесь только отрисовка
// трёх видов элементов: показатель, строка очереди, задача.
import { api, escapeHtml, renderInto } from './api.js';

const ZONE_ICON = { analysis: '◔', plan: '▦', exec: '▶', tasks: '☑' };
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
  <span class="arm-l">${escapeHtml(item.label)}</span>
  <span class="bi-tag ${item.tone || ''}">${escapeHtml(item.tag || '')}</span>${go(item.screen)}</div>`;

function zoneHtml(zone, title, items, data) {
  const metrics = items.filter(item => item.kind === 'metric');
  const rest = items.filter(item => item.kind !== 'metric');
  const empty = zone === 'tasks' ? 'Открытых задач нет' : 'Нет данных';
  return `<section class="section s6 arm-zone arm-${zone}">
    <div class="sec-h"><span class="sn">${ZONE_ICON[zone]}</span><span class="st">${escapeHtml(title)}</span>
      <span class="hint">${zone === 'analysis' ? 'мои показатели' : zone === 'plan' ? 'сегодня · завтра' : zone === 'exec' ? 'сейчас' : 'на мне'}</span></div>
    <div class="sec-b">
      ${metrics.length ? `<div class="bi-kpis arm-kpis">${metrics.map(metric).join('')}</div>` : ''}
      ${rest.map(item => item.kind === 'task' ? task(item) : row(item)).join('')}
      ${!items.length ? `<div class="bi-empty">${empty}</div>` : ''}
      ${zone === 'tasks' ? `<div class="muted arm-next">${escapeHtml(data.assignedNote || '')}</div>` : ''}
    </div></section>`;
}

export async function renderArm(container, context) {
  let data;
  try { data = await api('/api/arm'); } catch (error) {
    container.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    return;
  }
  if (!data.pilot) {
    container.innerHTML = '<div class="empty-state">Рабочее место для вашей должности появится на следующем этапе.</div>';
    return;
  }
  const p = data.person;
  if (!renderInto(container, `<div class="bi-page arm-page">
    <div class="section arm-head dept-${escapeHtml(p.dept)}">
      <div><div class="arm-name">${escapeHtml(p.name)}${p.position ? ` · ${escapeHtml(p.position)}` : ''}</div>
        <div class="muted">${escapeHtml([p.deptName, p.shift].filter(Boolean).join(' · '))}</div>
        ${p.deptTask ? `<div class="arm-task-dept">Задача отдела: ${escapeHtml(p.deptTask)}</div>` : ''}</div>
    </div>
    <div class="bi-grid arm-grid">${Object.keys(data.zones).map(zone => zoneHtml(zone, data.zoneTitles[zone], data.zones[zone], data)).join('')}</div>
  </div>`)) return;
  container.onclick = event => {
    const goto = event.target.closest('[data-goto]');
    if (goto) document.querySelector(`#viewTabs [data-view="${goto.dataset.goto}"]`)?.click();
  };
}
