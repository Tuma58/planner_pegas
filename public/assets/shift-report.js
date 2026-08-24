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
    <td><b>${escapeHtml(person.name)}</b>${person.jobRole ? ` <small class="muted">· ${escapeHtml(person.jobRole)}</small>` : ''}</td>
    <td style="text-align:right"><b>${person.total}</b></td>
    <td style="text-align:right" title="Медиана по ${person.withTime} операциям с измеримым временем">${waitLabel(person.medianWaitMs)}</td>
    <td>${person.ops.map(([name, count]) => `${escapeHtml(name)} — ${count}`).join(' · ')}</td>
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
      <button type="button" class="button ghost small" id="shiftPrint" style="margin-left:auto">🖨 Печать</button>
    </div>
    <h3 style="margin:10px 0 6px">Сотрудники <span class="badge">${report.staff.length}</span></h3>
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
  document.getElementById('shiftPrint').onclick = () => window.print();
}
