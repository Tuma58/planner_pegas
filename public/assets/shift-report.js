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
  ['sales', 'Планирование: заявки ждут подтверждения'],
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

  const effCell = person => {
    const value = person.efficiency;
    const cls = value >= 120 ? 'ok' : value < 70 ? 'bad' : '';
    const hint = `Эффективность к среднему по должности за 7 дней: нагрузка ×${person.loadIdx}` +
      `${person.baseLoad ? ` (средняя ${person.baseLoad} операций за смену)` : ''}, ` +
      `скорость ×${person.speedIdx}${person.baseWaitMs ? ` (средняя обработка ${waitLabel(person.baseWaitMs)})` : ''}. ` +
      'Формула: 60% нагрузка + 40% скорость.';
    return `<td class="num" title="${escapeHtml(hint)}"><span class="badge ${cls}"><b>${value}%</b></span></td>`;
  };
  const staffRows = report.staff.map(person => `<tr>
    <td><b>${escapeHtml(person.name)}</b>${person.jobRole ? ` <small class="muted">· ${escapeHtml(person.jobRole)}</small>` : ''}
      ${person.planned ? '' : ' <span class="badge warn" title="Работал, но в график этой смены не назначен">⚡ вне графика</span>'}</td>
    ${effCell(person)}
    <td class="num"><b>${person.total}</b></td>
    <td class="num" title="Медиана по ${person.withTime} операциям с измеримым временем">${waitLabel(person.medianWaitMs)}</td>
    <td>${person.ops.map(([name, count]) => `${escapeHtml(name)} — ${count}`).join(' · ')}</td>
  </tr>`).join('');

  const signalRows = (report.signals || []).map(signal => {
    const icon = signal.kind === 'low' ? '🔻' : signal.kind === 'overload' ? '🔥' : '🛠';
    return `<li style="margin:3px 0">${icon} ${escapeHtml(signal.text)}</li>`;
  }).join('');

  // Сравнение должностей: объём и время против собственной нормы за 7 дней.
  const idxBadge = (value, goodHigh) => {
    if (value == null) return '—';
    const good = goodHigh ? value >= 1.2 : value >= 1.2;
    const bad = value < 0.7;
    return `<span class="badge ${good ? 'ok' : bad ? 'bad' : ''}">×${value}</span>`;
  };
  const roleRows = (report.roles || []).map(role => `<tr>
    <td><b>${escapeHtml(role.role)}</b></td>
    <td class="num">${role.people}</td>
    <td class="num"><b>${role.totalOps}</b></td>
    <td class="num" title="${role.baseLoad ? `обычно ${role.baseLoad} операций на человеко-смену` : 'базы нет'}">${role.opsPerPerson}</td>
    <td class="num" title="${role.baseWaitMs ? `обычно ${waitLabel(role.baseWaitMs)}` : 'нет измеримых операций'}">${waitLabel(role.medianWaitMs)}</td>
    <td class="num" title="Нагрузка на человека к средней по должности за 7 дней">${idxBadge(role.loadIdx, true)}</td>
    <td class="num" title="Скорость обработки к средней по должности за 7 дней (больше — быстрее)">${idxBadge(role.speedIdx, true)}</td>
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
    <td class="num"><b>${operation.total}</b></td>
    <td class="num" title="Медианное время от передачи задания предыдущим звеном до выполнения">${waitLabel(operation.medianWaitMs)}</td>
    <td>${operation.by.map(([name, count]) => `${escapeHtml(name)} — ${count}`).join(' · ')}</td>
  </tr>`).join('');

  const queueRows = QUEUE_LABELS.map(([key, label]) => {
    const start = report.queuesStart[key];
    const end = report.queuesEnd[key];
    const delta = end - start;
    return `<tr><td>${escapeHtml(label)}</td>
      <td class="num">${start}</td>
      <td class="num"><b>${end}</b></td>
      <td class="num"><b class="${delta > 0 ? 'danger' : ''}">${delta > 0 ? '+' : ''}${delta}</b></td></tr>`;
  }).join('');

  // Смена ещё идёт: план пополняется по мере внесения заказов, операции и
  // медианы растут — окончательные цифры будут после конца смены.
  const nowMs = Date.now();
  const stateBadge = nowMs < Date.parse(report.fromIso)
    ? '<span class="badge">смена ещё не началась</span>'
    : nowMs < Date.parse(report.toIso)
      ? '<span class="badge warn" title="План пополняется по мере внесения заказов, операции и очереди меняются — окончательные цифры после конца смены">⏳ смена идёт — данные предварительные</span>'
      : '<span class="badge ok" title="Смена завершена — операции и очереди зафиксированы">✓ смена завершена — итог</span>';
  // BI-вид (04.11): плитки план-факта смены → секции с таблицами .bi-table.
  const plannedCount = (report.plan?.planned || []).length;
  const sla = report.assignSla;
  const slaTone = sla ? (sla.pct >= 95 ? 'pos' : sla.pct >= 80 ? 'warn' : 'neg') : '';
  const queueGrowth = QUEUE_LABELS.filter(([key]) => report.queuesEnd[key] - report.queuesStart[key] > 0).length;
  context.showModal(`<div class="report printable-block bi-page shift-bi">
    <div class="bi-sub"><h2 style="margin-bottom:2px">🕐 Отчёт за смену ${stateBadge}</h2>
      <p class="geohint">${escapeHtml(report.label)} · операции с именами исполнителей по журналу системы
      · «обработка» — медианное время от передачи задания предыдущим звеном до выполнения</p></div>
    <div class="console no-print bi-actions-row">
      <input type="date" id="shiftDay" value="${report.day}">
      <select id="shiftKind">
        <option value="day" ${report.kind === 'day' ? 'selected' : ''}>дневная 08:00–20:00</option>
        <option value="night" ${report.kind === 'night' ? 'selected' : ''}>ночная 20:00–08:00</option>
      </select>
      <button type="button" class="button small" id="shiftGo">Показать</button>
      <button type="button" class="button ghost small" id="shiftSchedule">📅 График смен</button>
      <button type="button" class="button ghost small" id="shiftPrint" style="margin-left:auto">🖨 Печать</button>
    </div>
    <div class="bi-kpis">
      <div class="metric dept-staff"><span class="l">В графике</span><span class="v">${plannedCount}<small>чел</small></span>
        <span class="d">назначены на смену</span></div>
      <div class="metric ${report.plan?.noShow ? 'neg' : 'pos'}"><span class="l">⚠ Не вышли</span>
        <span class="v">${report.plan?.noShow || 0}</span><span class="d">в графике, операций нет</span></div>
      <div class="metric ${report.plan?.offPlan ? 'warn' : ''}"><span class="l">⚡ Вне графика</span>
        <span class="v">${report.plan?.offPlan || 0}</span><span class="d">работали без назначения</span></div>
      <div class="metric dept-staff"><span class="l">Фактически работали</span>
        <span class="v">${report.staff.length}<small>чел</small></span><span class="d">видов операций: ${report.operations.length}</span></div>
      ${sla ? `<div class="metric ${slaTone}" title="Вовремя — за ≥6 ч до погрузки"><span class="l">SLA назначения ТС</span>
        <span class="v">${sla.pct}<small>%</small></span><span class="d">${sla.onTime} из ${sla.total} · цель ≥95%</span></div>` : ''}
      <div class="metric ${queueGrowth ? 'warn' : 'pos'}"><span class="l">Очереди растут</span>
        <span class="v">${queueGrowth}<small>из ${QUEUE_LABELS.length}</small></span><span class="d">звеньев каскада с «+»</span></div>
    </div>
    <div class="bi-grid">
    <section class="section ${signalRows ? 's6' : ''}">
      <div class="sec-h"><span class="st">План-факт по людям</span>
        <span class="bi-tag">${plannedCount} в графике</span>
        ${report.plan?.noShow ? `<span class="bi-tag neg">⚠ не вышли: ${report.plan.noShow}</span>` : ''}
        ${report.plan?.offPlan ? `<span class="bi-tag warn">⚡ вне графика: ${report.plan.offPlan}</span>` : ''}</div>
      <div class="sec-b flush bi-scroll"><table class="bi-table">
        <thead><tr><th>По графику на смене</th><th>Факт</th></tr></thead><tbody>
        ${planRows || `<tr><td colspan="2" class="muted">На эту смену никто не назначен —
          заполните «📅 График смен», чтобы видеть план-факт.</td></tr>`}
      </tbody></table></div>
    </section>
    ${signalRows ? `<section class="section s6">
      <div class="sec-h"><span class="st">Сигналы эффективности</span></div>
      <div class="sec-b"><ul style="margin:0;padding-left:18px">${signalRows}</ul></div>
    </section>` : ''}
    <section class="section">
      <div class="sec-h"><span class="st">Сравнение должностей</span>
        <span class="hint">«к норме» — база 7 дней</span></div>
      <div class="sec-b flush bi-scroll"><table class="bi-table">
        <thead><tr><th>Должность</th><th class="r">Людей</th><th class="r">Операций</th><th class="r">На человека</th>
          <th class="r">Обработка (медиана)</th><th class="r" title="Нагрузка на человека к средней по должности за 7 дней">Нагрузка к норме</th>
          <th class="r" title="Скорость обработки к средней по должности за 7 дней; больше — быстрее">Скорость к норме</th></tr></thead><tbody>
        ${roleRows || '<tr><td colspan="7" class="muted">Операций за смену нет.</td></tr>'}
      </tbody></table></div>
      <div class="sec-b"><p class="muted" style="margin:0">Между собой должности сравниваются по отклонению от
        собственной нормы («к норме» — база 7 дней): операции у ролей разные по природе, поэтому
        прямое сравнение штук и минут между должностями — только ориентир.</p></div>
    </section>
    <section class="section">
      <div class="sec-h"><span class="st">Сотрудники — фактически работали</span>
        <span class="bi-tag">${report.staff.length}</span></div>
      <div class="sec-b flush bi-scroll"><table class="bi-table">
        <thead><tr><th>Сотрудник</th><th class="r" title="К среднему по должности за 7 дней: 60% нагрузка + 40% скорость обработки">Эффективность</th><th class="r">Операций</th><th class="r">Обработка (медиана)</th><th>Что делал</th></tr></thead><tbody>
        ${staffRows || '<tr><td colspan="5" class="muted">Операций за смену не зафиксировано.</td></tr>'}
      </tbody></table></div>
      ${sla ? `<div class="sec-b"><p style="margin:0">
        <b>SLA назначения ТС:</b> вовремя (за ≥6 ч до погрузки) —
        <span class="badge ${sla.pct >= 95 ? 'ok' : sla.pct >= 80 ? 'warn' : 'bad'}">
          <b>${sla.onTime} из ${sla.total} · ${sla.pct}%</b></span>
        <small class="muted">цель ≥95%</small></p></div>` : ''}
    </section>
    <section class="section s7">
      <div class="sec-h"><span class="st">Операции</span><span class="bi-tag">${report.operations.length}</span></div>
      <div class="sec-b flush bi-scroll"><table class="bi-table">
        <thead><tr><th>Операция</th><th class="r">Всего</th><th class="r">Обработка (медиана)</th><th>Кто выполнял</th></tr></thead><tbody>
        ${operationRows || '<tr><td colspan="4" class="muted">Пусто.</td></tr>'}
      </tbody></table></div>
    </section>
    <section class="section s5">
      <div class="sec-h"><span class="st">Каскад: очереди звеньев</span><span class="hint">план от предыдущего</span></div>
      <div class="sec-b flush"><table class="bi-table">
        <thead><tr><th>Очередь</th><th class="r">Начало смены</th><th class="r">Конец смены</th><th class="r">±</th></tr></thead><tbody>
        ${queueRows}
      </tbody></table></div>
      <div class="sec-b"><p class="muted" style="margin:0">Очередь на конец смены — это план следующей смены звена:
        задания, переданные предыдущим по каскаду и ещё не обработанные. Рост очереди (+) — сигнал,
        где конвейер копит задержку.${report.otherCount ? ` Служебных действий вне конвейера за смену: ${report.otherCount}.` : ''}</p></div>
    </section>
    </div>
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
  // График смен: руководитель (shifts:write) или полный доступ к справочнику.
  const canWrite = typeof context.can === 'function'
    ? context.can('shifts:write') || Boolean(context.state?.data?.user?.staffAccess) : true;
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
    <section class="section">
      <div class="sec-h"><span class="st">Сотрудники × дни недели</span>
        <span class="hint">Д — дневная · Н — ночная</span></div>
      <div class="sec-b flush bi-scroll" style="max-height:60vh"><table class="bi-table shift-grid">
        <thead><tr><th>Сотрудник</th>${header}</tr></thead><tbody>${rows}</tbody>
      </table></div>
    </section>
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
