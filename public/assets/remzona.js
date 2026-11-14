// Блок «Ремзона» — АВТОНОМНАЯ конструкция (этап 1, 14.09.2026): очередь
// заказ-нарядов механика со статусной моделью «очередь → в работе →
// готов → выдан», работами и одометрами. До этапа интеграции блок НЕ
// влияет на подбор, гант и занятость машин — копит собственные факты,
// из которых позже выучатся нормативы длительности работ.
import { api, escapeHtml, formatDateTime, toast, renderInto } from './api.js';
import { readXlsx } from './xlsx-read.js';

const PURPOSES = ['ТО', 'плановый ремонт', 'поломка на линии', 'ДТП', 'шины', 'документы', 'прочее'];
const STATUS_LABEL = {
  queued: '📥 Очередь', in_progress: '🔧 В работе', ready: '✅ Готовы', released: '🚚 Выданы (14 дн)'
};

const fmt = iso => iso ? new Date(iso).toLocaleString('ru-RU',
  { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' }) : '—';

// Запчасти наряда со склада (склад ТОиР, 07.11): кнопка у наряда тем, кому
// виден «Склад запчастей»; выдача — там же, «🔧 На наряд».
function partsVisible(state, can) {
  const access = state?.data?.user?.access;
  return !access || access.legacy ? can('fleet:write') || can('reports:read') : access.views.includes('parts');
}

function orderCardHtml(order, can, state) {
  const jobsDone = order.jobs.filter(job => job.status === 'done').length;
  const write = can('fleet:write');
  const actions = !write ? '' : {
    queued: `<button class="button small" data-ra="start" data-ro="${order.id}">▶ В работу</button>
      <button class="button ghost small" data-ra="cancel" data-ro="${order.id}">✕</button>`,
    in_progress: `<button class="button small" data-ra="ready" data-ro="${order.id}">✅ Готово</button>`,
    ready: `<button class="button small" data-ra="release" data-ro="${order.id}">🚚 Выдать</button>
      <button class="button ghost small" data-ra="reopen" data-ro="${order.id}">↩ Доработать</button>`,
    released: ''
  }[order.status] || '';
  return `<div class="list-item" style="flex-direction:column;align-items:stretch;gap:4px">
    <div style="display:flex;gap:8px;align-items:center">
      <strong class="mono vlink" data-vinfo="${order.vehicle_id}">${escapeHtml(order.plate)}</strong>
      <span class="badge">${escapeHtml(order.purpose)}</span>
      <small class="muted">${escapeHtml(order.vehicle_type || '')}</small>
      <span style="margin-left:auto">${partsVisible(state, can) ? `<button class="button ghost small" data-rparts="${order.id}"
        data-rplate="${escapeHtml(order.plate)}" title="Запчасти, выданные со склада на этот наряд">🔩</button> ` : ''}${actions}</span>
    </div>
    ${order.complaint ? `<small>${escapeHtml(order.complaint)}</small>` : ''}
    <small class="muted">заезд ${fmt(order.arrived_at)}${order.odometer_km
      ? ` · одометр ${Math.round(order.odometer_km).toLocaleString('ru-RU')} км` : ''}${order.planned_out
      ? ` · выход план ${fmt(order.planned_out)}` : ''}${order.mechanic_name
      ? ` · ${escapeHtml(order.mechanic_name)}` : ''}</small>
    ${order.status === 'released' ? `<small class="muted">выдан ${fmt(order.released_at)}</small>` : `
    <div>
      ${order.jobs.map(job => `<div style="display:flex;gap:6px;align-items:center;padding:1px 0">
        ${write ? `<input type="checkbox" data-rj="${job.id}" ${job.status === 'done' ? 'checked' : ''}>` : (job.status === 'done' ? '☑' : '☐')}
        <span style="flex:1;${job.status === 'done' ? 'opacity:.6' : ''}">${escapeHtml(job.title)}${job.parts
          ? ` <small class="muted">(${escapeHtml(job.parts)})</small>` : ''}${job.hours ? ` <small class="muted">· ${job.hours} ч</small>` : ''}</span>
        ${write ? `<button class="button ghost small" data-rjdel="${job.id}" title="Убрать работу">✕</button>` : ''}
      </div>`).join('')}
      ${order.jobs.length ? `<small class="muted">работы: ${jobsDone}/${order.jobs.length}</small>` : ''}
      ${write && order.status !== 'released' ? `<button class="button ghost small" data-rjadd="${order.id}">＋ работа</button>` : ''}
    </div>`}
  </div>`;
}

export async function renderRemzona(container, context) {
  const { state, can, showModal, closeModal } = context;
  let payload;
  try { payload = await api('/api/repairs'); } catch (error) {
    container.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    return;
  }
  const groups = { queued: [], in_progress: [], ready: [], released: [] };
  for (const item of payload.items) if (groups[item.status]) groups[item.status].push(item);
  // BI-вид (04.11): колонка статуса = секция доски .bi-board.
  const columns = ['queued', 'in_progress', 'ready', 'released'].map(status => `
    <section class="section dept-toir rz-col">
      <div class="sec-h"><span class="st">${STATUS_LABEL[status]}</span>
        <div class="sec-actions"><span class="bi-tag">${groups[status].length}</span></div></div>
      <div class="sec-b"><div class="list">${groups[status].map(order => orderCardHtml(order, can, state)).join('')
        || '<div class="bi-empty">пусто</div>'}</div></div>
    </section>`).join('');
  // Запросы выпуска от логистов (решение руководителя 04.11): борт в
  // ремонте не назначается на рейс — логист шлёт запрос, механик правит
  // заезд/диспозицию штатно и отвечает здесь; автор получает личное
  // уведомление, после выпуска назначение открывается.
  const releaseRows = (payload.releaseRequests || []).map(item => `<div class="list-item" style="gap:8px">
      <span style="flex:1;min-width:0">
        <b class="mono">${escapeHtml(item.plate)}</b>
        ${item.status === 'open' ? '<span class="badge warn">ждёт ответа</span>'
    : item.status === 'done' ? '<span class="badge ok">выпущен</span>' : '<span class="badge">отказ</span>'}
        <small class="muted" style="display:block">${escapeHtml(item.requested_by_name)}
          · ${formatDateTime(String(item.created_at).replace(' ', 'T') + 'Z')}
          ${item.need_by ? ` · нужна к ${formatDateTime(item.need_by)}` : ''}
          ${item.note ? ` · ${escapeHtml(item.note)}` : ''}
          ${item.resolution ? ` → ${escapeHtml(item.resolution)} (${escapeHtml(item.resolved_by_name || '')})` : ''}</small>
      </span>
      ${item.status === 'open' && can('fleet:write') ? `
        <button class="button small" data-rz-release="${item.id}" data-rz-action="done"
          title="Сначала скорректируйте заезд/диспозицию, затем подтвердите — логист получит уведомление">✅ Выпускаю</button>
        <button class="button ghost small" data-rz-release="${item.id}" data-rz-action="declined">✖ Не выпущу</button>` : ''}
    </div>`).join('');
  const openRequests = (payload.releaseRequests || []).filter(item => item.status === 'open').length;
  const jobsLeft = [...groups.queued, ...groups.in_progress]
    .reduce((sum, order) => sum + order.jobs.filter(job => job.status !== 'done').length, 0);
  const tile = (label, value, unit, extra = '', note = '') => `<div class="metric ${extra}">
    <span class="l">${label}</span><span class="v">${value}<small>${unit}</small></span>
    ${note ? `<span class="d">${note}</span>` : ''}</div>`;
  renderInto(container, `<div class="bi-page svc-rz">
    <div class="bi-sub"><h2>Заказ-наряды механика</h2>
      <p>блок автономен: на подбор машин и гант пока не влияет —
        недоступность ТС по-прежнему ставится диспозицией в «Ресурсе»</p>
      ${can('fleet:write') ? `<div class="bi-actions">
        <label class="button ghost small" title="Выгрузка 1С:УАТ с листами «Заявки на ремонт», «Работы по заявкам», «Ремонтные листы» — повторная загрузка обновляет, не дублирует">⬆ История из 1С<input type="file" id="rzImport" accept=".xlsx" hidden></label>
        <button class="button small" id="rzNew">🚚 Новый заезд</button></div>` : ''}
    </div>
    <div class="bi-kpis bi-kpis-row">
      ${tile('В очереди', groups.queued.length, 'маш', 'dept-toir', 'ждут механика')}
      ${tile('В работе', groups.in_progress.length, 'маш', 'dept-toir', `открытых работ ${jobsLeft}`)}
      ${tile('Готовы', groups.ready.length, 'маш', groups.ready.length ? 'pos' : 'dept-toir', 'к выдаче')}
      ${tile('Выданы', groups.released.length, 'маш', 'dept-toir', 'за 14 дней')}
      ${tile('Запросы выпуска', openRequests, 'шт', openRequests ? 'warn' : 'dept-toir', 'ждут ответа механика')}
    </div>
    ${releaseRows ? `<section class="section dept-toir">
      <div class="sec-h"><span class="st">📨 Запросы выпуска от логистов</span>
        <span class="hint">ответ уходит логисту личным уведомлением</span></div>
      <div class="sec-b"><div class="list">${releaseRows}</div></div>
    </section>` : ''}
    <div class="bi-board rz-board">${columns}</div>
    <div id="rzHistory"></div>
  </div>`);
  renderToirHistory(container.querySelector('#rzHistory'));
  container.querySelectorAll('[data-rz-release]').forEach(button =>
    button.addEventListener('click', async () => {
      const action = button.dataset.rzAction;
      const resolution = prompt(action === 'done'
        ? 'Что сделали (заезд сокращён/закрыт, к какому времени машина готова):'
        : 'Почему не выпускаете (причина обязательна):');
      if (resolution === null) return;
      if (!resolution.trim()) { toast('Пояснение обязательно', 'error'); return; }
      try {
        await api(`/api/remzona/release-requests/${button.dataset.rzRelease}`, { method: 'POST',
          body: JSON.stringify({ action, resolution: resolution.trim() }) });
        toast('Ответ отправлен — логист получил личное уведомление');
        renderRemzona(container, context);
      } catch (error) { toast(error.message, 'error'); }
    }));
  const refresh = () => renderRemzona(container, context);
  container.querySelector('#rzImport')?.addEventListener('change', async event => {
    const file = event.currentTarget.files[0];
    event.currentTarget.value = '';
    if (!file) return;
    toast('Разбираю выгрузку — листы большие, подождите…');
    try {
      const result = await importToirFile(file);
      toast(`История ТОиР: заявок новых ${result.requests.added}, обновлено ${result.requests.updated}, работ ${result.requests.jobs}, РЛ ${result.sheets.count}${result.requests.skipped.length ? `, пропущено ${result.requests.skipped.length} (прицепы — в деньгах РЛ)` : ''}`);
      refresh();
    } catch (error) { toast(error.message, 'error'); }
  });
  container.querySelector('#rzNew')?.addEventListener('click', () => {
    const vehicles = (state.data.vehicles || []).filter(vehicle => vehicle.status === 'work')
      .slice().sort((a, b) => a.plate.localeCompare(b.plate, 'ru'));
    showModal(`<form id="rzForm"><h2>🚚 Новый заезд в ремзону</h2>
      <label class="field">Машина<select name="vehicleId" required>
        ${vehicles.map(vehicle => `<option value="${vehicle.id}">${escapeHtml(vehicle.plate)}</option>`).join('')}
      </select></label>
      <label class="field">Причина заезда<select name="purpose">
        ${PURPOSES.map(reason => `<option>${reason}</option>`).join('')}</select></label>
      <label class="field">Что случилось / дефекты<textarea name="complaint" rows="3"
        placeholder="со слов водителя или по осмотру"></textarea></label>
      <label class="field">Плановый выход<input type="datetime-local" name="plannedOut"></label>
      <p class="muted">Одометр борта снимется сам с CAN-датчика. Недоступность машины
        для планирования этот заезд пока НЕ ставит — до этапа интеграции её ведёт «Ресурс».</p>
      <div class="modal-actions">
        <button type="button" class="button ghost" data-close>Отмена</button>
        <button class="button">Создать заказ-наряд</button>
      </div></form>`);
    document.getElementById('rzForm').onsubmit = async event => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(event.currentTarget));
      if (values.plannedOut) values.plannedOut = new Date(values.plannedOut).toISOString();
      try {
        await api('/api/repairs', { method: 'POST', body: JSON.stringify(values) });
        closeModal(); toast('Заказ-наряд создан'); refresh();
      } catch (error) { toast(error.message, 'error'); }
    };
  });
  container.querySelectorAll('[data-ra]').forEach(button => button.addEventListener('click', async () => {
    try {
      await api(`/api/repairs/${button.dataset.ro}`, {
        method: 'PATCH', body: JSON.stringify({ action: button.dataset.ra }) });
      refresh();
    } catch (error) { toast(error.message, 'error'); }
  }));
  container.querySelectorAll('[data-rparts]').forEach(button => button.addEventListener('click', async () => {
    let data;
    try { data = await api(`/api/parts/orders/${encodeURIComponent(button.dataset.rparts)}`); } catch (error) { toast(error.message); return; }
    const rub = value => value == null ? '—' : `${Math.round(value).toLocaleString('ru-RU')} ₽`;
    showModal(`<h2>🔩 Запчасти наряда · <span class="mono">${escapeHtml(button.dataset.rplate)}</span></h2>
      ${data.parts.length ? `<table class="bi-table"><thead><tr><th>Позиция</th><th class="r">Кол-во</th><th>День</th><th>Выдал</th>${data.money !== false ? '<th class="r">Себестоимость</th>' : ''}</tr></thead>
        <tbody>${data.parts.map(row => `<tr><td>${escapeHtml(row.name)}${row.code ? ` <small class="muted">${escapeHtml(row.code)}</small>` : ''}</td>
          <td class="num">${row.qty} ${escapeHtml(row.unit)}</td><td>${escapeHtml(String(row.day || '').split('-').reverse().join('.'))}</td>
          <td>${escapeHtml(row.created_by_name || '')}</td>${data.money !== false ? `<td class="num">${rub(row.cost)}</td>` : ''}</tr>`).join('')}</tbody></table>
        ${data.money !== false && data.cost != null ? `<p class="muted">Итого без НДС: ${rub(data.cost)} — справочно; затрата признана при закупке.</p>` : ''}`
    : '<div class="empty-state">Со склада на наряд ничего не выдавали</div>'}
      <p class="muted">Выдать — «Склад запчастей» → «🔧 На наряд».</p>
      <div class="modal-actions"><button type="button" class="button ghost" data-close>Закрыть</button></div>`);
  }));
  container.querySelectorAll('[data-rjadd]').forEach(button => button.addEventListener('click', () => {
    const title = prompt('Работа (например: замена колодок передней оси)');
    if (!title) return;
    const parts = prompt('Запчасти/материалы (можно пусто)') || '';
    api(`/api/repairs/${button.dataset.rjadd}/jobs`, {
      method: 'POST', body: JSON.stringify({ title, parts })
    }).then(refresh).catch(error => toast(error.message, 'error'));
  }));
  container.querySelectorAll('[data-rj]').forEach(checkbox => checkbox.addEventListener('change', () => {
    const done = checkbox.checked;
    const hours = done ? Number(prompt('Часы работы (для нормативов, можно пусто)') || '') : null;
    api(`/api/repairs/jobs/${checkbox.dataset.rj}`, {
      method: 'PATCH', body: JSON.stringify({ done, hours: Number.isFinite(hours) && hours > 0 ? hours : undefined })
    }).then(refresh).catch(error => { toast(error.message, 'error'); refresh(); });
  }));
  container.querySelectorAll('[data-rjdel]').forEach(button => button.addEventListener('click', () => {
    api(`/api/repairs/jobs/${button.dataset.rjdel}`, { method: 'DELETE' })
      .then(refresh).catch(error => toast(error.message, 'error'));
  }));
}

// ── 📜 История ТОиР из 1С (14.11) ──
// Сводка живёт под доской: месяцы × группы, топ бортов по деньгам.
// Деньги сервер отдаёт по правам (money=full/отчёты) — иначе прочерки.
const rub = value => value == null ? '—' : `${Math.round(value).toLocaleString('ru-RU')} ₽`;

async function renderToirHistory(container) {
  if (!container) return;
  let data;
  try { data = await api('/api/repairs/history'); } catch { return; }
  if (!data.totals.n) return; // истории ещё нет — секцию не показываем
  container.innerHTML = `<section class="section dept-toir">
    <div class="sec-h"><span class="st">📜 История ТОиР из 1С</span>
      <span class="hint">${data.totals.n.toLocaleString('ru-RU')} РЛ · ${escapeHtml(data.totals.mn || '')}–${escapeHtml(data.totals.mx || '')} · итог ${rub(data.totals.rub)}</span></div>
    <div class="sec-b flush"><table class="bi-table"><thead><tr><th>Месяц</th><th>По группам</th></tr></thead>
      <tbody>${data.months.map(month => `<tr><td>${escapeHtml(month.month)}</td>
        <td>${month.groups.map(group => `<span class="bi-tag">${escapeHtml(group.group)}: ${group.n}${group.rub == null ? '' : ` · ${rub(group.rub)}`}</span>`).join(' ')}</td></tr>`).join('')}</tbody></table></div>
    <div class="sec-b flush"><table class="bi-table"><thead><tr><th>Борт (топ по деньгам)</th><th class="r">РЛ</th><th class="r">Часы</th><th class="r">Итого</th></tr></thead>
      <tbody>${data.topVehicles.map(row => `<tr><td>${escapeHtml(row.plate)} <span class="muted">${escapeHtml(row.vehicle_kind || '')}</span></td>
        <td class="num">${row.n}</td><td class="num">${row.hours == null ? '—' : Math.round(row.hours).toLocaleString('ru-RU')}</td><td class="num">${rub(row.rub)}</td></tr>`).join('')}</tbody></table></div>
  </section>`;
}

// Разбор выгрузки 1С: три листа, колонки ищем по заголовкам.
async function importToirFile(file) {
  const headerMap = rows => {
    const header = rows[0].map(cell => String(cell || '').toLowerCase().trim());
    return { header, col: part => header.findIndex(cell => cell.startsWith(part)) };
  };
  const value = (row, index) => index >= 0 ? String(row[index] ?? '').trim() : '';
  const requestsRows = await readXlsx(file, 'Заявки на ремонт');
  const req = headerMap(requestsRows);
  const rq = {
    no: req.col('номер заявки'), date: req.col('дата'), plate: req.col('тс'),
    purpose: req.col('назначение (как в планере)'), status: req.col('статус (как в планере)'),
    status1c: req.col('статус (1с)'), complaint: req.col('причина обращения'),
    defects: req.col('неисправности'), rec: req.col('рекомендации'), note: req.col('комментарий'),
    km: req.col('пробег'), planOut: req.col('окончание (план)'), arrived: req.col('факт заезда'),
    finished: req.col('факт окончания'), started: req.col('передан в работу'), released: req.col('выполнен')
  };
  if (rq.no < 0 || rq.plate < 0) throw new Error('Не похоже на выгрузку ТОиР: нет листа «Заявки на ремонт» с колонками «Номер заявки», «ТС»');
  const requests = requestsRows.slice(1).filter(row => value(row, rq.no)).map(row => ({
    externalNo: value(row, rq.no), createdAt: value(row, rq.date), plate: value(row, rq.plate),
    purpose: value(row, rq.purpose), status: value(row, rq.status), status1c: value(row, rq.status1c),
    complaint: value(row, rq.complaint), defects: value(row, rq.defects), recommendations: value(row, rq.rec),
    note: value(row, rq.note), odometerKm: value(row, rq.km), plannedOut: value(row, rq.planOut),
    arrivedAt: value(row, rq.arrived), finishedAt: value(row, rq.finished),
    workStartedAt: value(row, rq.started), releasedAt: value(row, rq.released)
  }));
  const worksRows = await readXlsx(file, 'Работы по заявкам');
  const wk = headerMap(worksRows);
  const wc = { no: wk.col('номер заявки'), line: wk.col('строка'), title: wk.col('неисправность'), confirmed: wk.col('работа подтверждена') };
  const works = worksRows.slice(1).filter(row => value(row, wc.no)).map(row => ({
    externalNo: value(row, wc.no), line: value(row, wc.line) || 1,
    title: value(row, wc.title), confirmed: value(row, wc.confirmed)
  }));
  const sheetRows = await readXlsx(file, 'Ремонтные листы');
  const sh = headerMap(sheetRows);
  const sc = {
    no: sh.col('номер рл'), month: sh.col('месяц'), plate: sh.col('тс'), vkind: sh.col('тягач'),
    kind: sh.col('вид обслуживания'), group: sh.col('группа'), status: sh.col('статус'),
    started: sh.col('начало'), finished: sh.col('окончание'), hours: sh.col('часов в ремонте'),
    km: sh.col('пробег'), works: sh.col('работы атп'), partsStock: sh.col('запчасти со склада'),
    outsourced: sh.col('ремонт сторонний'), partsBought: sh.col('запчасти покупные'),
    tires: sh.col('шины'), wash: sh.col('мойка'), total: sh.col('итого без ндс'),
    pay: sh.col('вид оплаты'), reqKey: sh.col('заявка на ремонт')
  };
  const sheets = sheetRows.slice(1).filter(row => value(row, sc.no)).map(row => ({
    externalNo: value(row, sc.no), month: value(row, sc.month), plate: value(row, sc.plate),
    vehicleKind: value(row, sc.vkind), kind: value(row, sc.kind), groupKind: value(row, sc.group),
    status: value(row, sc.status), startedAt: value(row, sc.started), finishedAt: value(row, sc.finished),
    hours: value(row, sc.hours), odometerKm: value(row, sc.km), worksRub: value(row, sc.works),
    partsStockRub: value(row, sc.partsStock), outsourcedRub: value(row, sc.outsourced),
    partsBoughtRub: value(row, sc.partsBought), tiresRub: value(row, sc.tires), washRub: value(row, sc.wash),
    totalRub: value(row, sc.total), payKind: value(row, sc.pay), requestKey: value(row, sc.reqKey)
  }));
  return api('/api/repairs/import', { method: 'POST', body: JSON.stringify({ requests, works, sheets }) });
}
