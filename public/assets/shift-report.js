// Отчёт за смену («🕐 Смена» в блоке руководителя): операции сотрудников
// по именам собственным, медианное время обработки задания и очереди
// каскада (план каждого звена — задания от предыдущего). Смены по 12 часов
// МСК: дневная 08:00–20:00, ночная 20:00–08:00. Данные считает сервер
// (GET /api/shift-report) по журналу операций.
import { api, escapeHtml, toast } from './api.js';

// «2 мин» / «1 ч 40 мин» / «2 дн» — человеческое время обработки.
function waitLabel(ms) {
  if (ms == null) return '—';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return '< 1 мин';
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч ${minutes % 60} мин`;
  return `${Math.floor(hours / 24)} дн ${hours % 24} ч`;
}

const QUEUE_LABELS = [
  ['sales', 'Продажи: заявки ждут подтверждения'],
  ['logist', 'Логист: подтверждённые ждут назначения ТС'],
  ['logistConfirm', 'Логист: назначения ждут подтверждения'],
  ['dispatcher', 'Диспетчер: рейсы в подготовке выхода'],
  ['accountant', 'Бухгалтерия: выгруженные ждут оплаты']
];

export async function shiftDialog(context, day = '', kind = '') {
  let report;
  try {
    const query = day ? `?day=${day}&shift=${kind}` : '';
    report = await api(`/api/shift-report${query}`);
  } catch (error) { toast(error.message, 'error'); return; }

  const staffRows = report.staff.map(person => `<tr>
    <td><b>${escapeHtml(person.name)}</b>${person.jobRole ? ` <small class="muted">· ${escapeHtml(person.jobRole)}</small>` : ''}
      ${person.planned ? '' : ' <span class="badge warn" title="Работал, но в график этой смены не назначен">⚡ вне графика</span>'}</td>
    <td style="text-align:right"><b>${person.total}</b></td>
    <td style="text-align:right" title="Медиана по ${person.withTime} операциям с измеримым временем">${waitLabel(person.medianWaitMs)}</td>
    <td>${person.ops.map(([name, count]) => `${escapeHtml(name)} — ${count}`).join(' · ')}</td>
  </tr>`).join('');

  // План-факт по людям: назначенные на смену — вышли или нет.
  const planRows = (report.plan?.planned || []).map(person => `<tr>
    <td><b>${escapeHtml(person.name)}</b>${person.jobRole ? ` <small class="muted">· ${escapeHtml(person.jobRole)}</small>` : ''}</td>
    <td>${person.worked
    ? '<span class="badge ok">✓ вышел — операции есть</span>'
    : '<span class="badge bad">⚠ не вышел — операций нет</span>'}</td>
  </tr>`).join('');

  const operationRows = report.operations.map(operation => `<tr>
    <td><b>${escapeHtml(operation.name)}</b></td>
    <td style="text-align:right"><b>${operation.total}</b></td>
    <td style="text-align:right" title="Медианное время от передачи задания предыдущим звеном до выполнения">${waitLabel(operation.medianWaitMs)}</td>
    <td>${operation.by.map(([name, count]) => `${escapeHtml(name)} — ${count}`).join(' · ')}</td>
  </tr>`).join('');

  const queueRows = QUEUE_LABELS.map(([key, label]) => {
    const start = report.queuesStart[key];
    const end = report.queuesEnd[key];
    const delta = end - start;
    return `<tr><td>${escapeHtml(label)}</td>
      <td style="text-align:right">${start}</td>
      <td style="text-align:right"><b>${end}</b></td>
      <td style="text-align:right"><b class="${delta > 0 ? 'danger' : ''}">${delta > 0 ? '+' : ''}${delta}</b></td></tr>`;
  }).join('');

  context.showModal(`<div class="report printable-block">
    <h2 style="margin-bottom:2px">🕐 Отчёт за смену</h2>
    <div class="geohint">${escapeHtml(report.label)} · операции с именами исполнителей по журналу системы
      · «обработка» — медианное время от передачи задания предыдущим звеном до выполнения</div>
    <div class="console no-print" style="margin:10px 0">
      <input type="date" id="shiftDay" value="${report.day}">
      <select id="shiftKind">
        <option value="day" ${report.kind === 'day' ? 'selected' : ''}>дневная 08:00–20:00</option>
        <option value="night" ${report.kind === 'night' ? 'selected' : ''}>ночная 20:00–08:00</option>
      </select>
      <button type="button" class="button small" id="shiftGo">Показать</button>
      <button type="button" class="button ghost small" id="shiftSchedule">📅 График смен</button>
      <button type="button" class="button ghost small" id="shiftPrint" style="margin-left:auto">🖨 Печать</button>
    </div>
    <h3 style="margin:10px 0 6px">План-факт по людям
      <span class="badge">${(report.plan?.planned || []).length} в графике</span>
      ${report.plan?.noShow ? `<span class="badge bad">⚠ не вышли: ${report.plan.noShow}</span>` : ''}
      ${report.plan?.offPlan ? `<span class="badge warn">⚡ вне графика: ${report.plan.offPlan}</span>` : ''}</h3>
    <div class="table-wrap"><table>
      <tr><th>По графику на смене</th><th>Факт</th></tr>
      ${planRows || `<tr><td colspan="2" class="muted">На эту смену никто не назначен —
        заполните «📅 График смен», чтобы видеть план-факт.</td></tr>`}
    </table></div>
    <h3 style="margin:14px 0 6px">Сотрудники — фактически работали <span class="badge">${report.staff.length}</span></h3>
    <div class="table-wrap"><table>
      <tr><th>Сотрудник</th><th>Операций</th><th>Обработка (медиана)</th><th>Что делал</th></tr>
      ${staffRows || '<tr><td colspan="4" class="muted">Операций за смену не зафиксировано.</td></tr>'}
    </table></div>
    <h3 style="margin:14px 0 6px">Операции <span class="badge">${report.operations.length}</span></h3>
    <div class="table-wrap"><table>
      <tr><th>Операция</th><th>Всего</th><th>Обработка (медиана)</th><th>Кто выполнял</th></tr>
      ${operationRows || '<tr><td colspan="4" class="muted">Пусто.</td></tr>'}
    </table></div>
    <h3 style="margin:14px 0 6px">Каскад: очереди звеньев (план от предыдущего)</h3>
    <div class="table-wrap"><table>
      <tr><th>Очередь</th><th>Начало смены</th><th>Конец смены</th><th>±</th></tr>
      ${queueRows}
    </table></div>
    <p class="muted" style="margin-top:8px">Очередь на конец смены — это план следующей смены звена:
      задания, переданные предыдущим по каскаду и ещё не обработанные. Рост очереди (+) — сигнал,
      где конвейер копит задержку.${report.otherCount ? ` Служебных действий вне конвейера за смену: ${report.otherCount}.` : ''}</p>
  </div>
  <div class="modal-actions no-print">
    <button type="button" class="button ghost" data-close>Закрыть</button>
  </div>`, 'wide printable');

  document.getElementById('shiftGo').onclick = () => shiftDialog(context,
    document.getElementById('shiftDay').value, document.getElementById('shiftKind').value);
  document.getElementById('shiftSchedule').onclick = () => scheduleDialog(context, report.day);
  document.getElementById('shiftPrint').onclick = () => window.print();
}

// ── График смен: сетка «сотрудники × дни недели», клик циклит — → Д → Н → — ──
const DAY_MS = 86_400_000;
const WEEKDAYS = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];

export async function scheduleDialog(context, anchorDay = '') {
  const canWrite = typeof context.can === 'function' ? context.can('shifts:write') : true;
  // Неделя с понедельника, в которую попадает опорный день.
  const anchorMs = Date.parse(`${anchorDay || new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  const monday = anchorMs - ((new Date(anchorMs).getUTCDay() + 6) % 7) * DAY_MS;
  const days = Array.from({ length: 7 }, (_, i) => new Date(monday + i * DAY_MS).toISOString().slice(0, 10));

  let payload;
  try {
    payload = await api(`/api/staff-shifts?from=${days[0]}&to=${days[6]}`);
  } catch (error) { toast(error.message, 'error'); return; }
  // Карта назначений: userId|day → 'day'/'night'.
  const marks = new Map(payload.items.map(item => [`${item.user_id}|${item.day}`, item.kind]));

  const cell = (userId, day) => {
    const kind = marks.get(`${userId}|${day}`);
    const label = kind === 'day' ? 'Д' : kind === 'night' ? 'Н' : '·';
    const cls = kind === 'day' ? 'ok' : kind === 'night' ? 'warn' : '';
    return `<td style="text-align:center;cursor:${canWrite ? 'pointer' : 'default'}"
      data-shift-cell="${userId}|${day}" title="${day}: клик — пусто → дневная → ночная → пусто">
      <span class="badge ${cls}">${label}</span></td>`;
  };
  const header = days.map((day, i) =>
    `<th style="text-align:center">${WEEKDAYS[i]}<br><small class="muted">${day.slice(8)}.${day.slice(5, 7)}</small></th>`).join('');
  const rows = payload.staff.map(person => `<tr>
    <td><b>${escapeHtml(person.full_name)}</b>${person.job_role ? ` <small class="muted">· ${escapeHtml(person.job_role)}</small>` : ''}</td>
    ${days.map(day => cell(person.id, day)).join('')}
  </tr>`).join('');

  context.showModal(`<h2>📅 График смен сотрудников</h2>
    <p class="muted" style="margin:0 0 10px">Неделя ${days[0].split('-').reverse().join('.')} —
      ${days[6].split('-').reverse().join('.')} · Д — дневная 08:00–20:00, Н — ночная 20:00–08:00
      (день ячейки — начало смены). ${canWrite ? 'Клик по ячейке переключает: пусто → Д → Н → пусто.'
    : 'Изменение графика — у руководителя и администратора.'}
      Назначения видны в «🕐 Отчёте смены» как план-факт по людям.</p>
    <div class="console" style="margin-bottom:8px">
      <button type="button" class="button ghost small" id="schedulePrev">← неделя</button>
      <button type="button" class="button ghost small" id="scheduleNext">неделя →</button>
    </div>
    <div class="table-wrap" style="max-height:60vh;overflow:auto"><table>
      <tr><th>Сотрудник</th>${header}</tr>${rows}
    </table></div>
    <div class="modal-actions"><button type="button" class="button ghost" data-close>Закрыть</button></div>`,
  'wide');

  document.getElementById('schedulePrev').onclick = () =>
    scheduleDialog(context, new Date(monday - 7 * DAY_MS).toISOString().slice(0, 10));
  document.getElementById('scheduleNext').onclick = () =>
    scheduleDialog(context, new Date(monday + 7 * DAY_MS).toISOString().slice(0, 10));
  if (!canWrite) return;
  document.querySelectorAll('[data-shift-cell]').forEach(cellNode =>
    cellNode.addEventListener('click', async () => {
      const [userId, day] = cellNode.dataset.shiftCell.split('|');
      const current = marks.get(`${userId}|${day}`);
      // Цикл: пусто → дневная → ночная → пусто (переключатель на сервере).
      try {
        if (current === 'day') {
          await api('/api/staff-shifts', { method: 'POST', body: JSON.stringify({ userId, day, kind: 'day' }) });
          await api('/api/staff-shifts', { method: 'POST', body: JSON.stringify({ userId, day, kind: 'night' }) });
          marks.set(`${userId}|${day}`, 'night');
        } else if (current === 'night') {
          await api('/api/staff-shifts', { method: 'POST', body: JSON.stringify({ userId, day, kind: 'night' }) });
          marks.delete(`${userId}|${day}`);
        } else {
          await api('/api/staff-shifts', { method: 'POST', body: JSON.stringify({ userId, day, kind: 'day' }) });
          marks.set(`${userId}|${day}`, 'day');
        }
        const kind = marks.get(`${userId}|${day}`);
        cellNode.querySelector('.badge').textContent = kind === 'day' ? 'Д' : kind === 'night' ? 'Н' : '·';
        cellNode.querySelector('.badge').className = `badge ${kind === 'day' ? 'ok' : kind === 'night' ? 'warn' : ''}`;
      } catch (error) { toast(error.message, 'error'); }
    }));
}
