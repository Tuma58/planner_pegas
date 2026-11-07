// «Карточка ТС» по принципу 1С (решение руководителя 07.11.2026): реквизиты,
// нормы ТО на КАЖДУЮ машину (вручную) и состояние ТО по пробегу, сроки
// документов, история (Ремзона, рейсы, КПП, путевые листы). Затраты по
// машине здесь не показываются — они под персональным доступом.
// openVehicleCard — модальное окно карточки; renderToBoard — таблица
// «ТО по парку» (просрочено → скоро → ок → нет данных → нет нормы).
// Правка — у кого право fleet:write (механик: нормы ТО, Ресурс: документы).
import { api, escapeHtml, toast, renderInto } from './api.js';

const TO_LABEL = { overdue: ['ТО просрочено', 'neg'], soon: ['скоро ТО', 'warn'], ok: ['в норме', 'pos'],
  no_data: ['нет данных', ''], no_norm: ['нет нормы', ''] };
const DOC_LABEL = { expired: ['истёк', 'neg'], soon: ['скоро', 'warn'], ok: ['действует', 'pos'], unknown: ['не внесён', ''] };
const VEHICLE_STATUS = { work: 'в работе', repair: 'в ремонте', no_driver: 'без водителя', out: 'выведена' };
const REPAIR_STATUS = { queued: 'в очереди', in_progress: 'в работе', ready: 'готова', released: 'выпущена', cancelled: 'отменён' };
const TRIP_STATUS = { plan: 'план', run: 'в пути', unloaded: 'выгружен', done: 'выполнен', paid: 'оплачен', rejected: 'отказ' };
const GATE_STATUS = { onsite: 'на стоянке', out: 'выехал', cancelled: 'аннулирован' };
const WAYBILL_STATUS = { draft: 'черновик', issued: 'выдан', closed: 'закрыт' };

const km = value => value == null ? '—' : `${Math.round(value).toLocaleString('ru-RU')} км`;
const dt = iso => iso ? new Date(iso).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
const day = value => value ? value.split('-').reverse().join('.') : '—';
const tag = ([label, tone]) => `<span class="bi-tag ${tone}">${escapeHtml(label)}</span>`;
const row = (k, v) => `<div class="bi-row"><span class="k">${escapeHtml(k)}</span><span class="v">${v || '—'}</span></div>`;
const text = v => v ? escapeHtml(v) : '';

// Поле формы правки: [ключ, подпись, тип input].
const REQ_FIELDS = [['vin', 'VIN', 'text'], ['year', 'Год выпуска', 'number'], ['sts_number', 'СТС', 'text'],
  ['pts_number', 'ПТС', 'text'], ['owner', 'Собственник', 'text'], ['lessor', 'Лизингодатель', 'text'],
  ['glonass_id', 'ID ГЛОНАСС', 'text'], ['tracker', 'Трекер', 'text'], ['note', 'Примечание', 'text']];
const NORM_FIELDS = [['to_interval_km', 'Межсервисный интервал, км', 'number'], ['hou_interval_mh', 'ТО ХОУ, моточасы', 'number'],
  ['tires_note', 'Шины', 'text']];
const DOC_FIELDS = [['osago_until', 'ОСАГО до'], ['kasko_until', 'КАСКО до'], ['techinspect_until', 'Техосмотр (диагн. карта) до'],
  ['tacho_until', 'Тахограф (поверка/карта) до'], ['lease_until', 'Лизинг до']];

function toBlock(to) {
  const [label, tone] = TO_LABEL[to.status] || ['—', ''];
  const share = to.intervalKm && to.sinceKm != null ? Math.min(100, Math.round(to.sinceKm / to.intervalKm * 100)) : null;
  const base = to.odoBase ? `${km(to.odoBase.odo_km)} на ${day(to.odoBase.day)} (снимок ${to.odoBase.side === 'before' ? 'до' : 'после'} выпуска)` : '—';
  return `<div class="vc-to"><div class="vc-to-head">${tag([label, tone])}
      ${to.leftKm != null ? `<b class="mono">${to.leftKm > 0 ? `до ТО ${km(to.leftKm)}` : `перепробег ${km(-to.leftKm)}`}</b>` : ''}
      ${to.reason ? `<span class="muted">${escapeHtml(to.reason)}</span>` : ''}</div>
    ${share != null ? `<div class="bi-meter ${tone}"><i style="width:${share}%"></i></div>` : ''}
    <div class="bi-list">
      ${row('Последний ТО (выпуск из Ремзоны)', escapeHtml(dt(to.lastToAt)))}
      ${row('Одометр на ТО', escapeHtml(base))}
      ${row('Одометр сейчас', to.odoNowKm != null ? `${km(to.odoNowKm)} · ${day(to.odoNowDay)}` : '—')}
      ${row('Пробег с ТО', km(to.sinceKm))}
      ${row('Собственный пробег, медиана 28 сут', to.avgDayKm != null ? `${km(to.avgDayKm)}/сут` : 'нет движения')}
      ${row('«Скоро» — остаток меньше пробега за горизонт', `${escapeHtml(String(to.horizonDays))} сут`)}
    </div></div>`;
}

function viewHtml(data) {
  const { vehicle: v, card: c, to, docs, history: h } = data;
  const empty = '<tr><td colspan="5" class="muted">нет записей</td></tr>';
  return `<div class="vc-card">
    <div class="vc-head"><h2>🪪 Паспорт ТС · <span class="mono">${escapeHtml(v.plate)}</span></h2>
      <span class="muted">${escapeHtml([v.type, v.model].filter(Boolean).join(' · '))}</span>
      ${data.canWrite ? '<button type="button" class="button small" data-vc-edit>✎ Править</button>' : ''}</div>
    <div class="bi-grid vc-grid">
      <section class="section s6"><div class="sec-h"><span class="st">Реквизиты</span></div><div class="sec-b"><div class="bi-list">
        ${row('Статус', escapeHtml(VEHICLE_STATUS[v.status] || v.status))}
        ${row('Водитель', text(v.driver))}
        ${row('Прицеп', text([v.trailerPlate, v.trailerModel].filter(Boolean).join(' · ')))}
        ${row('VIN', text(c.vin))}${row('Год выпуска', c.year ? escapeHtml(String(c.year)) : '')}
        ${row('СТС', text(c.sts_number))}${row('ПТС', text(c.pts_number))}
        ${row('Собственник', text(c.owner))}${row('Лизингодатель', text(c.lessor))}
        ${row('ID ГЛОНАСС', text(c.glonass_id))}${row('Трекер', text(c.tracker))}
        ${c.note ? `<div class="vc-note">${escapeHtml(c.note)}</div>` : ''}
      </div></div></section>
      <section class="section s6 dept-toir"><div class="sec-h"><span class="st">Нормы ТО и состояние ТО</span>
        <span class="hint">нормы — вручную на машину</span></div><div class="sec-b">
        <div class="bi-list">
          ${row('Межсервисный интервал', c.to_interval_km ? km(c.to_interval_km) : '<span class="muted">не задан</span>')}
          ${row('ТО ХОУ', c.hou_interval_mh ? `${escapeHtml(String(c.hou_interval_mh))} м/ч` : '<span class="muted">не задано</span>')}
          ${row('Шины', text(c.tires_note))}
        </div>${toBlock(to)}</div></section>
      <section class="section dept-drv"><div class="sec-h"><span class="st">Документы и сроки</span>
        <span class="hint">«скоро» — за ${escapeHtml(String(data.warnDays))} сут и меньше (Настройки)</span></div>
        <div class="sec-b flush"><table class="bi-table"><thead><tr><th>Документ</th><th>Действует до</th><th class="r">Осталось</th><th>Статус</th></tr></thead>
        <tbody>${docs.map(item => `<tr><td>${escapeHtml(item.label)}</td><td class="mono">${day(item.until)}</td>
          <td class="num">${item.daysLeft == null ? '—' : `${item.daysLeft} сут`}</td><td>${tag(DOC_LABEL[item.status])}</td></tr>`).join('')}</tbody></table></div></section>
      <section class="section"><div class="sec-h"><span class="st">История</span><span class="hint">последние записи</span></div>
        <div class="sec-b vc-hist">
        <h4>Ремзона</h4><table class="bi-table"><thead><tr><th>Заезд</th><th>Выпуск</th><th>Причина</th><th>Что случилось</th><th>Статус</th></tr></thead>
          <tbody>${h.repairs.map(r => `<tr><td class="mono">${dt(r.arrived_at)}</td><td class="mono">${dt(r.released_at)}</td>
            <td>${escapeHtml(r.purpose)}</td><td>${escapeHtml(r.complaint)}</td><td>${escapeHtml(REPAIR_STATUS[r.status] || r.status)}</td></tr>`).join('') || empty}</tbody></table>
        <h4>Рейсы</h4><table class="bi-table"><thead><tr><th>Выход</th><th>Маршрут</th><th>Статус</th></tr></thead>
          <tbody>${h.trips.map(t => `<tr><td class="mono">${dt(t.starts_at)}</td><td>${escapeHtml(`${t.from_zone || '?'} → ${t.to_zone || '?'}`)}</td>
            <td>${escapeHtml(TRIP_STATUS[t.status] || t.status)}</td></tr>`).join('') || empty}</tbody></table>
        ${h.gate ? `<h4>КПП</h4><table class="bi-table"><thead><tr><th>Въезд</th><th>Выезд</th><th>Статус</th></tr></thead>
          <tbody>${h.gate.map(g => `<tr><td class="mono">${dt(g.entry_at)}</td><td class="mono">${dt(g.exit_at)}</td>
            <td>${escapeHtml(GATE_STATUS[g.status] || g.status)}</td></tr>`).join('') || empty}</tbody></table>` : ''}
        ${h.waybills ? `<h4>Путевые листы</h4><table class="bi-table"><thead><tr><th>№</th><th>Начало</th><th>Статус</th></tr></thead>
          <tbody>${h.waybills.map(w => `<tr><td class="mono">${escapeHtml(`${w.number}/${w.year}`)}</td><td class="mono">${dt(w.starts_at)}</td>
            <td>${escapeHtml(WAYBILL_STATUS[w.status] || w.status)}</td></tr>`).join('') || empty}</tbody></table>` : ''}
      </div></section>
    </div>
    <p class="muted vc-foot">${data.updatedAt ? `Карточку правил: ${escapeHtml(data.updatedBy || '—')} · ${dt(data.updatedAt)}` : 'Карточка ещё не заполнялась'}</p>
    <div class="modal-actions"><button type="button" class="button ghost" data-close>Закрыть</button></div></div>`;
}

function editHtml(data) {
  const c = data.card;
  const input = ([key, label, type]) => `<label class="field">${escapeHtml(label)}<input name="${key}" type="${type}"
    ${type === 'number' ? 'step="any" min="0"' : ''} value="${escapeHtml(c[key] ?? '')}"></label>`;
  return `<form id="vcForm" class="vc-card"><h2>✎ Паспорт ТС · <span class="mono">${escapeHtml(data.vehicle.plate)}</span></h2>
    <p class="muted">Номер, модель, сцепка и водитель ведутся в «Ресурсе»; здесь — реквизиты, нормы ТО и сроки документов. Пустое поле = «не задано».</p>
    <div class="bi-grid vc-grid">
      <section class="section s6"><div class="sec-h"><span class="st">Реквизиты</span></div><div class="sec-b"><div class="fields">${REQ_FIELDS.map(input).join('')}</div></div></section>
      <section class="section s6 dept-toir"><div class="sec-h"><span class="st">Нормы ТО</span><span class="hint">ТОиР · на эту машину</span></div>
        <div class="sec-b"><div class="fields">${NORM_FIELDS.map(input).join('')}</div></div></section>
      <section class="section dept-drv"><div class="sec-h"><span class="st">Документы и сроки</span><span class="hint">эксплуатация</span></div>
        <div class="sec-b"><div class="fields three">${DOC_FIELDS.map(([key, label]) => input([key, label, 'date'])).join('')}</div></div></section>
    </div>
    <div class="form-error" id="vcErr"></div>
    <div class="modal-actions"><button type="button" class="button ghost" data-vc-cancel>Отмена</button><button class="button">Сохранить</button></div></form>`;
}

// Модальное окно карточки. context: { showModal, closeModal, can }.
export async function openVehicleCard(vehicleId, context) {
  let data;
  try {
    data = await api(`/api/vehicle-card/${encodeURIComponent(vehicleId)}`);
  } catch (error) { toast(error.message); return; }
  const canWrite = Boolean(data.canWrite && (context.can ? context.can('fleet:write') : true));
  const show = () => {
    context.showModal(viewHtml({ ...data, canWrite }), 'wide');
    const edit = document.querySelector('[data-vc-edit]');
    if (edit) edit.onclick = showEdit;
  };
  const showEdit = () => {
    context.showModal(editHtml(data), 'wide');
    document.querySelector('[data-vc-cancel]').onclick = show;
    document.querySelector('#vcForm').addEventListener('submit', async event => {
      event.preventDefault();
      const form = event.currentTarget;
      const body = {};
      for (const [key] of [...REQ_FIELDS, ...NORM_FIELDS, ...DOC_FIELDS]) body[key] = form.elements[key].value;
      try {
        data = await api(`/api/vehicle-card/${encodeURIComponent(vehicleId)}`, { method: 'PATCH', body: JSON.stringify(body) });
        toast(`${data.vehicle.plate}: карточка сохранена`);
        context.onSaved?.(data);
        show();
      } catch (error) { document.querySelector('#vcErr').textContent = error.message; }
    });
  };
  show();
}

// Таблица «ТО по парку». Клик по строке — карточка ТС.
export async function renderToBoard(container, context) {
  let data;
  try {
    data = await api('/api/vehicle-card/to-status');
  } catch (error) {
    container.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    return;
  }
  const count = status => data.items.filter(item => item.status === status).length;
  if (!renderInto(container, `<div class="bi-page vc-board">
    <div class="bi-sub"><h2>ТО по парку</h2>
      <p>Пробег с последнего ТО — по журналу одометров; межсервисный интервал задаётся вручную в карточке каждой машины.
        «Скоро» — остаток меньше собственного пробега машины за горизонт плана (${escapeHtml(String(data.horizonDays))} сут).</p></div>
    <div class="bi-kpis">
      <div class="metric ${count('overdue') ? 'neg' : 'pos'}"><span class="l">ТО просрочено</span><span class="v">${count('overdue')}</span></div>
      <div class="metric ${count('soon') ? 'warn' : ''}"><span class="l">Скоро ТО</span><span class="v">${count('soon')}</span></div>
      <div class="metric pos"><span class="l">В норме</span><span class="v">${count('ok')}</span></div>
      <div class="metric dept-toir"><span class="l">Нет нормы / нет данных</span><span class="v">${count('no_norm')}<small>/ ${count('no_data')}</small></span></div>
    </div>
    <section class="section dept-toir"><div class="sec-h"><span class="st">Машины</span><span class="hint">просрочено → скоро → в норме → нет данных → нет нормы</span></div>
      <div class="sec-b flush bi-scroll"><table class="bi-table vc-to-table"><thead><tr><th>Машина</th><th>Состояние</th>
        <th class="r">Интервал</th><th class="r">С ТО</th><th class="r">Осталось</th><th class="r">Пробег/сут</th><th>Последний ТО</th></tr></thead>
      <tbody>${data.items.map(item => `<tr data-vc-open="${escapeHtml(item.vehicleId)}" class="vc-row">
        <td><b class="mono">${escapeHtml(item.plate)}</b></td>
        <td>${tag(TO_LABEL[item.status])}${item.reason ? `<div class="muted">${escapeHtml(item.reason)}</div>` : ''}</td>
        <td class="num">${km(item.intervalKm)}</td><td class="num">${km(item.sinceKm)}</td><td class="num">${km(item.leftKm)}</td>
        <td class="num">${km(item.avgDayKm)}</td><td class="mono">${dt(item.lastToAt)}</td></tr>`).join('')
        || '<tr><td colspan="7" class="muted">Машин нет</td></tr>'}</tbody></table></div></section>
  </div>`)) return;
  container.onclick = event => {
    const open = event.target.closest('[data-vc-open]');
    if (open) openVehicleCard(open.dataset.vcOpen, { ...context, onSaved: () => renderToBoard(container, context) });
  };
}
