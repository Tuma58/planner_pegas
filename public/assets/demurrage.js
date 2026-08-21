// Простой под погрузкой и под выгрузкой: единая плашка «⏳ Простои П/В»
// во всех рабочих блоках (продажи, логист, диспетчер, ресурс, руководитель),
// диалог со случаями и историей претензий, печатная форма документа
// на счёт клиенту. Сводка приходит в bootstrap (data.demurrage), детальный
// список — по клику через GET /api/demurrage. Записи истории формирует
// сервер ежедневно после 07:00 МСК (простой сверх бесплатного норматива
// от планового времени операции по заявке клиента).
import { api, escapeHtml, formatDateTime, money, toast } from './api.js';

const KIND_LABEL = { load: '⬆ погрузка', unload: '⬇ выгрузка' };
const STATUS_LABEL = {
  new: ['к выставлению', 'warn'],
  billed: ['выставлена', 'ok'],
  cancelled: ['отменена', '']
};

// Плашка-сводка в стиле KPI блоков: сейчас стоят сверх нормы + месяц.
export function demurrageChipHtml(data) {
  const summary = data.demurrage;
  if (!summary) return '';
  const hot = summary.openCount > 0;
  return `<div class="skpi clickable dmr-chip ${hot ? 'skpi-warn' : ''}" data-demurrage-chip
    title="Простой под погрузкой/выгрузкой сверх норматива от планового времени по заявке —
      случаи сейчас, история претензий и печать документа на счёт клиенту">
    <span class="skl">⏳ Простои П/В</span>
    <span class="skv">${summary.openCount}</span>
    <small class="skm">${hot ? `сейчас ⬆${summary.openLoad} ⬇${summary.openUnload} · ${money(summary.openAmount)}`
      : 'сверхнормативных нет'}${summary.monthCount
      ? ` · мес ${summary.monthCount} на ${money(summary.monthAmount)}` : ''}</small>
  </div>`;
}

export function wireDemurrageChip(container, context) {
  container.querySelectorAll('[data-demurrage-chip]').forEach(chip =>
    chip.addEventListener('click', () => demurrageDialog(context)));
}

const hoursLabel = value => `${(Math.round(value * 10) / 10).toLocaleString('ru-RU')} ч`;

// Печатная форма претензии — документ для выставления счёта клиенту.
function printClaim(claim, settings, context) {
  const finished = claim.finished_at
    ? formatDateTime(claim.finished_at)
    : 'стоит по настоящее время (простой продолжается)';
  const opLabel = claim.stop_kind === 'load' ? 'погрузкой' : 'выгрузкой';
  context.showModal(`<div class="report printable-block">
    <h3><span style="color:var(--teal);font-weight:800">ООО «ПегасЛогистик»</span></h3>
    <h2 style="margin:8px 0 2px">ПРЕТЕНЗИЯ по простою № ${escapeHtml(claim.order_no || '—')}-${claim.stop_kind === 'load' ? 'П' : 'В'}</h2>
    <div class="geohint">Сформирована ${formatDateTime(claim.updated_at || claim.created_at)} · система PegasLogistic</div>
    <p style="margin:12px 0 4px"><b>Кому:</b> ${escapeHtml(claim.customer_name || '—')}</p>
    <p>По заявке № ${escapeHtml(claim.order_no || '—')} (ТС ${escapeHtml(claim.vehicle_plate)},
      водитель ${escapeHtml(claim.driver_name || '—')}) допущен сверхнормативный простой
      транспортного средства под ${opLabel} в пункте «${escapeHtml(claim.point || '—')}».</p>
    <div class="table-wrap"><table>
      <tr><td>Плановое время операции по заявке</td><td><b>${formatDateTime(claim.plan_at)}</b></td></tr>
      <tr><td>Фактическое прибытие ТС</td><td>${formatDateTime(claim.arrived_at)}</td></tr>
      <tr><td>Фактическое завершение операции</td><td>${finished}</td></tr>
      <tr><td>Простой всего</td><td>${hoursLabel(claim.idle_hours)}</td></tr>
      <tr><td>Бесплатный норматив</td><td>${settings.freeHours} ч</td></tr>
      <tr><td>Сверхнормативный простой (к оплате)</td><td><b>${claim.paid_hours} ч</b> (каждый начатый час)</td></tr>
      <tr><td>Тариф</td><td>${money(claim.rate)} / ч</td></tr>
      <tr><td><b>Сумма к оплате</b></td><td><b>${money(claim.amount)}</b></td></tr>
    </table></div>
    <p style="margin-top:10px">Основание: отметки контроля перевозки в системе PegasLogistic
      (факты прибытия и завершения операции, зафиксированные диспетчером).
      Просим оплатить указанную сумму либо направить мотивированный ответ.</p>
  </div>
  <div class="modal-actions no-print">
    <button type="button" class="button" id="dmrPrint">🖨 Печать / PDF</button>
    <button type="button" class="button ghost" id="dmrBack">Назад к списку</button>
    <button type="button" class="button ghost" data-close>Закрыть</button>
  </div>`, 'wide printable');
  document.getElementById('dmrPrint').onclick = () => window.print();
  document.getElementById('dmrBack').onclick = () => demurrageDialog(context);
}

export async function demurrageDialog(context) {
  let payload;
  try { payload = await api('/api/demurrage'); } catch (error) {
    toast(error.message, 'error'); return;
  }
  const canWrite = typeof context.can === 'function' && context.can('orders:write');
  const { settings } = payload;
  const openCases = payload.cases.filter(item => item.open);
  const caseRow = item => `<div class="dmr-row">
    <span class="dmr-kind">${KIND_LABEL[item.kind]}</span>
    <span style="flex:1;min-width:0"><b class="mono">${escapeHtml(item.vehiclePlate)}</b>
      · ${escapeHtml(item.customer || '—')}${item.orderNo ? ` · № ${escapeHtml(item.orderNo)}` : ''}
      <small class="muted" style="display:block">${escapeHtml(item.point || '—')}
        · план ${formatDateTime(item.planAt)} · прибыл ${formatDateTime(item.arrivedAt)}</small></span>
    <span class="dmr-sum"><b class="danger">${hoursLabel(item.idleHours)}</b>
      <small class="muted" style="display:block">сверх ${item.paidHours} ч · ${money(item.amount)}</small></span>
  </div>`;
  const claimRow = claim => {
    const [label, cls] = STATUS_LABEL[claim.status] || [claim.status, ''];
    return `<div class="dmr-row ${claim.status === 'cancelled' ? 'dmr-off' : ''}">
      <span class="dmr-kind">${KIND_LABEL[claim.stop_kind === 'load' ? 'load' : 'unload']}</span>
      <span style="flex:1;min-width:0"><b class="mono">${escapeHtml(claim.vehicle_plate)}</b>
        · ${escapeHtml(claim.customer_name || '—')}${claim.order_no ? ` · № ${escapeHtml(claim.order_no)}` : ''}
        <span class="badge ${cls}">${label}</span>
        ${claim.finished_at ? '' : '<span class="badge warn">ещё стоит</span>'}
        <small class="muted" style="display:block">${escapeHtml(claim.point || '—')}
          · план ${formatDateTime(claim.plan_at)} · простой ${hoursLabel(claim.idle_hours)}
          · сверх ${claim.paid_hours} ч · <b>${money(claim.amount)}</b> · от ${String(claim.created_day).split('-').reverse().join('.')}</small></span>
      <span class="dmr-actions">
        <button class="button ghost small" data-dmr-print="${claim.id}" title="Документ для выставления счёта клиенту — печать / PDF">🖨</button>
        ${canWrite && claim.status === 'new' ? `<button class="button small" data-dmr-status="${claim.id}|billed" title="Отметить: счёт клиенту выставлен">✓ Выставлена</button>
          <button class="button ghost small" data-dmr-status="${claim.id}|cancelled" title="Отменить претензию (простой обоснован/договорённость)">✕</button>` : ''}
        ${canWrite && claim.status !== 'new' ? `<button class="button ghost small" data-dmr-status="${claim.id}|new" title="Вернуть в работу">↩</button>` : ''}
      </span>
    </div>`;
  };
  context.showModal(`<h2>⏳ Простой под погрузкой и выгрузкой</h2>
    <p class="muted" style="margin:0 0 10px">Норматив: ${settings.freeHours} ч бесплатно от
      планового времени операции по заявке клиента (но не раньше фактического прибытия ТС),
      сверх — ${money(settings.rate)} за каждый начатый час. История претензий формируется
      автоматически каждый день; факты берутся из отметок диспетчера.</p>
    <h3 style="margin:0 0 6px">Сейчас стоят сверх нормы <span class="badge ${openCases.length ? 'warn' : ''}">${openCases.length}</span></h3>
    <div class="dmr-list">${openCases.map(caseRow).join('')
      || '<div class="muted" style="padding:6px 0">Сверхнормативных простоев сейчас нет.</div>'}</div>
    <h3 style="margin:14px 0 6px">История претензий <span class="badge">${payload.claims.length}</span></h3>
    <div class="dmr-list" style="max-height:44vh;overflow:auto">${payload.claims.map(claimRow).join('')
      || '<div class="muted" style="padding:6px 0">Претензий пока нет — сформируются автоматически при простое сверх норматива.</div>'}</div>
    <div class="modal-actions"><button type="button" class="button ghost" data-close>Закрыть</button></div>`,
  'wide');
  document.querySelectorAll('[data-dmr-print]').forEach(button =>
    button.addEventListener('click', () => {
      const claim = payload.claims.find(item => item.id === button.dataset.dmrPrint);
      if (claim) printClaim(claim, settings, context);
    }));
  document.querySelectorAll('[data-dmr-status]').forEach(button =>
    button.addEventListener('click', async () => {
      const [id, status] = button.dataset.dmrStatus.split('|');
      try {
        await api(`/api/demurrage/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
        toast(status === 'billed' ? 'Отмечено: претензия выставлена'
          : status === 'cancelled' ? 'Претензия отменена' : 'Претензия возвращена в работу');
        demurrageDialog(context);
      } catch (error) { toast(error.message, 'error'); }
    }));
}
