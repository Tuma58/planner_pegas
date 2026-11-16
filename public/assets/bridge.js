// ⚓ «Мостик недели» — еженедельный обзор руководителя по Фридману
// (14.11.2026): выполнено · сорвано с причинами · наступившие точки
// контроля · перенесённое дважды · очередь недели · «окна хаоса» по
// факту · висяки дерева целей. Кнопка «📋 План недели» собирает текст
// повестки планёрки из этих же данных.
import { api, escapeHtml, renderInto, toast } from './api.js';

const ruDay = iso => iso ? String(iso).slice(0, 10).split('-').reverse().join('.') : '—';
const ruMoment = iso => iso ? `${ruDay(iso)} ${String(iso).slice(11, 16)}`.trim() : '—';
const DEPTS = { staff: 'Штаб', log: 'Логистика', drv: 'Эксплуатация', toir: 'ТОиР' };

export async function renderBridge(container, context) {
  const { state } = context;
  const back = state.bridgeBack || 0;
  let data;
  try {
    data = await api(`/api/bridge?back=${back}`);
  } catch (error) {
    container.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    return;
  }
  const s = data.summary;
  const taskRow = (task, extra = '') => `<tr>
    <td>${escapeHtml(task.title)}<div class="muted">${escapeHtml(task.from)} → ${escapeHtml(task.to)}</div></td>
    <td>${ruMoment(task.due)}</td><td>${extra}</td></tr>`;
  if (!renderInto(container, `<div class="bi-page">
    <div class="bi-sub"><h2>Мостик недели ${ruDay(data.weekFrom)} — ${ruDay(data.weekTo)}</h2>
      <p>Еженедельный обзор: что сделано, что сорвалось и почему, где наступил контроль, что переносится. По причинам срывов правятся оценки и доля резерва под внеплановое.</p>
      <div class="bi-actions">
        <button class="button ghost" id="brPrev">← неделя</button>
        ${back ? '<button class="button ghost" id="brNow">текущая</button>' : ''}
        <button class="button primary" id="brPlan">📋 План недели</button></div></div>
    <div class="bi-kpis">
      <div class="metric ${s.done ? 'pos' : ''}"><span class="l">Выполнено за неделю</span><span class="v">${s.done}</span></div>
      <div class="metric ${s.failed ? 'neg' : 'pos'}"><span class="l">Сорвано</span><span class="v">${s.failed}</span></div>
      <div class="metric ${s.overdue ? 'warn' : 'pos'}"><span class="l">Просрочено открытых</span><span class="v">${s.overdue}</span></div>
      <div class="metric ${s.controls ? 'warn' : 'pos'}"><span class="l">Точки контроля наступили</span><span class="v">${s.controls}</span></div>
      <div class="metric ${s.rebounced ? 'neg' : 'pos'}"><span class="l">Перенесено ≥2 раз</span><span class="v">${s.rebounced}</span></div>
    </div>
    <div class="bi-grid">
      <section class="section s6"><div class="sec-h"><span class="st">⏰ Наступившие точки контроля</span><span class="hint">делегировано — проверьте исполнение</span></div>
        <div class="sec-b flush"><table class="bi-table"><tbody>${data.controls.map(task => taskRow(task,
    `<span class="bi-tag warn">контроль ${ruMoment(task.control)}</span>`)).join('')
    || '<tr><td class="muted">наступивших нет</td></tr>'}</tbody></table></div></section>
      <section class="section s6"><div class="sec-h"><span class="st">🔁 Перенесено дважды и больше</span><span class="hint">дробить, делегировать или честно снять</span></div>
        <div class="sec-b flush"><table class="bi-table"><tbody>${data.rebounced.map(task => taskRow(task,
    `<span class="bi-tag neg">${task.postpones}×</span><div class="muted">${task.log.map(entry => escapeHtml(entry.reason)).join(' · ')}</div>`)).join('')
    || '<tr><td class="muted">таких нет</td></tr>'}</tbody></table></div></section>
      <section class="section s6"><div class="sec-h"><span class="st">✗ Сорвано за неделю</span><span class="hint">причина — из отметки «не сделано»</span></div>
        <div class="sec-b flush"><table class="bi-table"><tbody>${data.failed.map(task => taskRow(task,
    `<div class="muted">${escapeHtml(task.result || 'причина не указана')}</div>`)).join('')
    || '<tr><td class="muted">срывов нет</td></tr>'}</tbody></table></div></section>
      <section class="section s6"><div class="sec-h"><span class="st">⌛ Просроченные открытые</span></div>
        <div class="sec-b flush"><table class="bi-table"><tbody>${data.overdue.slice(0, 30).map(task => taskRow(task,
    task.postpones ? `<span class="bi-tag">${task.postpones}×</span>` : '')).join('')
    || '<tr><td class="muted">просроченных нет</td></tr>'}</tbody></table></div></section>
      <section class="section s6"><div class="sec-h"><span class="st">✓ Выполнено за неделю</span></div>
        <div class="sec-b flush"><table class="bi-table"><tbody>
          ${data.done.tasks.slice(0, 30).map(task => taskRow(task, '<span class="bi-tag pos">сделано</span>')).join('')}
          ${data.done.tickets.slice(0, 30).map(ticket => `<tr><td>${ticket.kind === 'tz' ? '📐' : '🛟'} ${escapeHtml(ticket.problem.slice(0, 90))}<div class="muted">${escapeHtml(ticket.author_name)}</div></td><td></td><td><span class="bi-tag pos">готово</span></td></tr>`).join('')}
          ${!data.done.tasks.length && !data.done.tickets.length ? '<tr><td class="muted">за неделю пусто</td></tr>' : ''}
        </tbody></table></div></section>
      <section class="section s6"><div class="sec-h"><span class="st">▶ Очередь на 7 дней</span><span class="hint">открытые задачи со сроком на неделе</span></div>
        <div class="sec-b flush"><table class="bi-table"><tbody>${data.queue.slice(0, 30).map(task => taskRow(task,
    `<span class="bi-tag">${task.status === 'work' ? 'в работе' : 'новая'}</span>`)).join('')
    || '<tr><td class="muted">очередь пуста</td></tr>'}</tbody></table></div></section>
      <section class="section s6"><div class="sec-h"><span class="st">🌪 Окна хаоса — факт внепланового</span><span class="hint">медиана прошлых недель — живой ориентир резерва</span></div>
        <div class="sec-b flush"><table class="bi-table"><thead><tr><th>Неделя с</th><th class="r">Внештатки</th><th class="r">Поверх диспозиции</th><th class="r">Заявки HELP DESK</th></tr></thead>
        <tbody>${data.chaos.weeks.map((week, index) => `<tr${index === data.chaos.weeks.length - 1 ? ' style="font-weight:600"' : ''}>
          <td>${ruDay(week.week)}</td><td class="num">${week.incidents}</td><td class="num">${week.overrides}</td><td class="num">${week.tickets}</td></tr>`).join('')}
        <tr><td class="muted">медиана 4 недель</td><td class="num muted">${data.chaos.median.incidents}</td><td class="num muted">${data.chaos.median.overrides}</td><td class="num muted">${data.chaos.median.tickets}</td></tr></tbody></table></div></section>
      <section class="section s6"><div class="sec-h"><span class="st">🎯 Висяки дерева целей</span><span class="hint">цель без задач и задача без цели не управляют</span></div>
        <div class="sec-b">${
    [...data.goals.goalsWithoutTasks.map(item => `<div>⚠ Цель без задач — ${DEPTS[item.dept] || item.dept}: ${escapeHtml(item.title)}</div>`),
      ...data.goals.tasksWithoutGoal.map(item => `<div>⚠ Задача без цели — ${DEPTS[item.dept] || item.dept}: ${escapeHtml(item.title)}</div>`)].join('')
    || '<div class="muted">дерево целей без дыр</div>'}
        ${data.goals.noMetric.length ? `<div class="muted" style="margin-top:6px">Без живого показателя: ${data.goals.noMetric.map(item => escapeHtml(item.title)).join(' · ')}</div>` : ''}</div></section>
    </div>
  </div>`)) return;
  const rerender = () => renderBridge(container, context);
  container.querySelector('#brPrev').onclick = () => { state.bridgeBack = back + 1; rerender(); };
  container.querySelector('#brNow')?.addEventListener('click', () => { state.bridgeBack = 0; rerender(); });
  container.querySelector('#brPlan').onclick = () => planWeekDialog(context, data);
}

// «ПЛАН НЕДЕЛИ» — текст повестки планёрки по шаблону Фридмана.
function planWeekDialog(context, data) {
  const line = task => `  ${task.title} — ${task.to} — срок ${ruMoment(task.due)}`;
  const text = [
    `ПЛАН НЕДЕЛИ [${ruDay(data.weekFrom)} – ${ruDay(data.weekTo)}]`,
    '', '1. Итоги прошлой недели',
    `   Выполнено (${data.done.tasks.length + data.done.tickets.length}):`,
    ...data.done.tasks.slice(0, 15).map(task => `   ✓ ${task.title} (${task.to})`),
    ...data.done.tickets.slice(0, 10).map(ticket => `   ✓ ${ticket.problem.slice(0, 80)} (${ticket.author_name})`),
    `   Сорвано / перенесено:`,
    ...data.failed.map(task => `   ✗ ${task.title} — ${task.result || 'причина не указана'}`),
    ...data.rebounced.map(task => `   ↻ ${task.title} — переносов ${task.postpones}`),
    '', '2. Очередь недели (по срокам)',
    ...data.queue.slice(0, 20).map(line),
    '', '3. Поручения и контроль',
    ...data.controls.map(task => `   ${task.to} — ${task.title} — контроль ${ruMoment(task.control)}`),
    '', '4. Внеплановое (неделя / медиана месяца)',
    `   внештатки ${data.chaos.weeks.at(-1).incidents} / ${data.chaos.median.incidents} · поверх диспозиции ${data.chaos.weeks.at(-1).overrides} / ${data.chaos.median.overrides} · заявки ${data.chaos.weeks.at(-1).tickets} / ${data.chaos.median.tickets}`
  ].join('\n');
  context.showModal(`<h2>📋 План недели — текст для планёрки</h2>
    <textarea rows="18" style="width:100%" id="brPlanText" readonly>${escapeHtml(text)}</textarea>
    <div class="modal-actions"><button class="button ghost" data-close>Закрыть</button>
      <button class="button primary" id="brCopy">Скопировать</button></div>`);
  document.querySelector('#brCopy').onclick = async () => {
    try { await navigator.clipboard.writeText(text); toast('Скопировано'); }
    catch { document.querySelector('#brPlanText').select(); document.execCommand('copy'); toast('Скопировано'); }
  };
}
