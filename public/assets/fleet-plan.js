// «🚛 План парка» — сетка машин на месяц, зеркало «Плана вывоза» со стороны
// ресурса: строки — сцепки, колонки — дни, ячейки — рейсы (по зонам),
// диспозиции и прогноз по назначенному кругу (шаблон К1–К8). Внизу — итог
// по дням: занято/свободно. Цель — покрыть сетку минимальным числом машин
// и УВИДЕТЬ высвобождаемый ресурс под новых клиентов, а не искать его по
// Ганту глазами.
import { api, escapeHtml, formatDateTime, money, toast } from './api.js';
import { ROUND_TEMPLATES, roundByKey } from './rounds.js';

const KIND_LABEL = { repair: '🔧 Ремонт', no_driver: '👤 Без водителя', shift: '🔁 Пересменка',
  reserve: '🅿 Резерв', out: '⛔ Выведена', transfer: '🚚 Перегон' };

// Открыть карточку рейса: полный рейс берём из bootstrap (в плане — срез).
const openPlanTrip = (context, tripId) => {
  const trip = (context.state?.data?.trips || []).find(item => item.id === tripId);
  if (trip && context.openTrip) context.openTrip(trip);
  else toast('Карточка рейса доступна из Ганта и Логиста');
};

// Диалог дня машины: рейсы (клик — карточка), диспозиции, свободный день.
function fpDayDialog(context, plan, vehicle, day, template) {
  const monthStartMs = Date.parse(`${plan.month}-01T00:00:00.000Z`);
  const from = monthStartMs + (day - 1) * 86_400_000;
  const to = from + 86_400_000;
  const dayTrips = plan.trips.filter(trip => trip.vehicle_id === vehicle.id &&
    Date.parse(trip.starts_at) < to && Date.parse(trip.ends_at) > from);
  const dayDisp = plan.dispositions.filter(item => item.vehicle_id === vehicle.id &&
    Date.parse(item.starts_at) < to && Date.parse(item.ends_at) > from);
  const stateLabel = { plan: 'в плане', run: 'в пути', unloaded: '✓ выгружен', done: '✓ завершён', paid: '✓ оплачен' };
  context.showModal(`<h2><span class="mono">${escapeHtml(vehicle.plate)}</span> · ${day} ${MONTHS[Number(plan.month.slice(5, 7)) - 1]}</h2>
    <p class="muted">${escapeHtml(vehicle.driver_name || 'без водителя')} · ${escapeHtml(vehicle.type_name || '')}</p>
    ${dayTrips.length ? `<div class="scolh">Рейсы дня <span>${dayTrips.length}</span></div>
      <div class="list">${dayTrips.map(trip => `<div class="list-item" data-fp-open-trip="${trip.id}"
          style="cursor:pointer" title="Карточка рейса">
        <span style="flex:1;min-width:0">${escapeHtml(trip.from_name)} → ${escapeHtml(trip.to_name)}
          <small class="muted" style="display:block">${escapeHtml(trip.customer_name || '')}
            · ${formatDateTime(trip.starts_at)} → ${formatDateTime(trip.ends_at)}</small></span>
        <span class="badge">${stateLabel[trip.status] || trip.status}</span>
        <b>${money(trip.revenue_vat)}</b></div>`).join('')}</div>` : ''}
    ${dayDisp.length ? `<div class="scolh" style="margin-top:8px">Диспозиции</div>
      <div class="list">${dayDisp.map(item => `<div class="list-item">
        <span style="flex:1">${KIND_LABEL[item.kind] || item.kind}</span>
        <span class="muted">${formatDateTime(item.starts_at)} → ${formatDateTime(item.ends_at)}</span></div>`).join('')}</div>` : ''}
    ${!dayTrips.length && !dayDisp.length ? `<p class="muted">${to > Date.now()
      ? `🟢 День свободен — ресурс под нового клиента.${template ? ` Прогноз по кругу ${escapeHtml(template.name)}.` : ' Круг не назначен.'}
        Грузы по зонам — во вкладке «Потоки».`
      : 'День прошёл без рейсов и диспозиций.'}</p>` : ''}
    <div class="modal-actions"><button type="button" class="button ghost" data-close>Закрыть</button></div>`);
  document.querySelectorAll('[data-fp-open-trip]').forEach(item =>
    item.addEventListener('click', () => openPlanTrip(context, item.dataset.fpOpenTrip)));
}

// Карточка машины: круг с примечанием, рейсы месяца, итоги.
function fpVehicleDialog(context, plan, row, flt) {
  const { vehicle, template, freeDays } = row;
  const canEdit = context.can('trips:write');
  const round = (plan.rounds || []).find(item => item.vehicle_id === vehicle.id);
  const myTrips = plan.trips.filter(trip => trip.vehicle_id === vehicle.id)
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  const revVat = myTrips.reduce((sum, trip) => sum + (trip.revenue_vat || 0), 0);
  const stateLabel = { plan: 'в плане', run: 'в пути', unloaded: '✓', done: '✓', paid: '✓' };
  context.showModal(`<h2><span class="mono">${escapeHtml(vehicle.plate)}</span></h2>
    <p class="muted">${escapeHtml(vehicle.driver_name || 'без водителя')} · ${escapeHtml(vehicle.type_name || '')}
      · за месяц: <b>${myTrips.length}</b> рейс. на <b>${money(Math.round(revVat))}</b>
      · 🟢 свободных дней: <b>${freeDays}</b></p>
    <div class="form-grid" style="grid-template-columns:2fr 3fr">
      <label class="field">🎡 Круг (План парка)
        ${canEdit ? `<select id="fpCardRound">
          <option value="">— без круга —</option>
          ${ROUND_TEMPLATES.map(item => `<option value="${item.key}" ${template?.key === item.key ? 'selected' : ''}>${escapeHtml(item.name)}</option>`).join('')}
        </select>` : `<input value="${escapeHtml(template?.name || '—')}" disabled>`}</label>
      <label class="field">Примечание к кругу
        <input id="fpCardNote" value="${escapeHtml(round?.note || '')}" ${canEdit ? '' : 'disabled'}
          placeholder="почему закреплена, до какого числа…"></label>
    </div>
    ${canEdit ? `<div class="modal-actions" style="justify-content:flex-start;margin-top:0">
      <button type="button" class="button small" id="fpCardSave">Сохранить круг</button></div>` : ''}
    <div class="scolh">Рейсы месяца <span>${myTrips.length}</span></div>
    <div class="list" style="max-height:38vh;overflow:auto">${myTrips.map(trip => `
      <div class="list-item" data-fp-open-trip="${trip.id}" style="cursor:pointer" title="Карточка рейса">
        <span style="flex:1;min-width:0">${escapeHtml(trip.from_name)} → ${escapeHtml(trip.to_name)}
          <small class="muted" style="display:block">${escapeHtml((trip.customer_name || '').slice(0, 30))}
            · ${formatDateTime(trip.starts_at)}</small></span>
        <span class="badge">${stateLabel[trip.status] || trip.status}</span>
        <b>${money(trip.revenue_vat)}</b></div>`).join('') || '<p class="muted">Рейсов в месяце нет.</p>'}</div>
    <div class="modal-actions">
      <button type="button" class="button ghost" data-vinfo="${vehicle.id}"
        title="Полная карточка ТС: прицеп, приписка, документы">🚛 Карточка ТС</button>
      <button type="button" class="button ghost" data-close>Закрыть</button></div>`, 'wide');
  document.getElementById('fpCardSave')?.addEventListener('click', async () => {
    try {
      await api('/api/fleet-plan/round', { method: 'POST', body: JSON.stringify({
        vehicleId: vehicle.id, roundKey: document.getElementById('fpCardRound').value,
        note: document.getElementById('fpCardNote').value.trim() }) });
      toast('Круг сохранён — прогноз перестроен');
      fleetPlanDialog(context, plan.month, flt);
    } catch (error) { toast(error.message, 'error'); }
  });
  document.querySelectorAll('[data-fp-open-trip]').forEach(item =>
    item.addEventListener('click', () => openPlanTrip(context, item.dataset.fpOpenTrip)));
}

const WD = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
  'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const DAY_MS = 86_400_000;
const KIND_SHORT = { repair: '🔧', no_driver: '👤', shift: '🔁', reserve: '🅿', out: '⛔', transfer: '🚚' };

// Зона → короткая метка для ячейки (первая буква, Москва/Дом различимы).
const zoneShort = name => ({ 'Москва': 'М', 'Дом': 'Д', 'Самара': 'С', 'Питер': 'П',
  'Черноземье': 'Ч', 'Восток': 'В', 'Юг': 'Ю', 'Запад': 'З', 'Золотое кольцо': 'К', 'Урал': 'У' }[name] || (name || '')[0] || '·');

export async function fleetPlanDialog(context, month = '', filters = {}) {
  let plan;
  try {
    plan = await api(`/api/fleet-plan${month ? `?month=${month}` : ''}`);
  } catch (error) { toast(error.message, 'error'); return; }
  // Рабочее поле: поиск, фильтр по кругу, «только резерв под новых клиентов».
  const flt = { query: '', round: '', freeOnly: false, ...filters };
  const { days, vehicles, trips, dispositions } = plan;
  const canEdit = context.can('trips:write');
  const monthStartMs = Date.parse(`${plan.month}-01T00:00:00.000Z`);
  const roundOf = new Map((plan.rounds || []).map(item => [item.vehicle_id, item]));
  const nowMs = Date.now();

  const tsMs = value => Date.parse(String(value).replace(' ', 'T') +
    (String(value).includes('Z') || String(value).includes('+') ? '' : 'Z'));

  // Ячейки машины: на каждый день — рейс / диспозиция / прогноз круга / пусто.
  const rowCells = vehicle => {
    const myTrips = trips.filter(trip => trip.vehicle_id === vehicle.id);
    const myDisp = dispositions.filter(item => item.vehicle_id === vehicle.id);
    const round = roundOf.get(vehicle.id);
    const template = round ? roundByKey(round.round_key) : null;
    // Последний занятый момент — от него раскатывается прогноз круга.
    let busyUntil = nowMs;
    for (const trip of myTrips) busyUntil = Math.max(busyUntil, Date.parse(trip.ends_at));
    for (const item of myDisp) busyUntil = Math.max(busyUntil, Date.parse(item.ends_at));

    const cells = [];
    let freeDays = 0;
    for (let day = 1; day <= days; day += 1) {
      const from = monthStartMs + (day - 1) * DAY_MS;
      const to = from + DAY_MS;
      const trip = myTrips.find(item => Date.parse(item.starts_at) < to &&
        (item.unloaded_at ? tsMs(item.unloaded_at) : Date.parse(item.ends_at)) > from);
      if (trip) {
        const label = `${zoneShort(trip.from_name)}→${zoneShort(trip.to_name)}`;
        const done = ['unloaded', 'done', 'paid'].includes(trip.status);
        cells.push({ cls: done ? 'fp-done' : trip.status === 'run' ? 'fp-run' : 'fp-plan',
          text: label, hint: `${trip.from_name} → ${trip.to_name} · ${formatDateTime(trip.starts_at)} → ${formatDateTime(trip.ends_at)}` });
        continue;
      }
      const disp = myDisp.find(item => Date.parse(item.starts_at) < to && Date.parse(item.ends_at) > from);
      if (disp) {
        cells.push({ cls: 'fp-disp', text: KIND_SHORT[disp.kind] || '·',
          hint: `${disp.kind} до ${formatDateTime(disp.ends_at)}` });
        continue;
      }
      // Будущий пустой день: прогноз по кругу, если он назначен.
      if (from >= busyUntil && template) {
        const cycleDay = Math.floor((from - busyUntil) / DAY_MS) % Math.ceil(template.days);
        cells.push({ cls: 'fp-fore', text: '·',
          hint: `прогноз по кругу ${template.name}: день ${cycleDay + 1} из ~${Math.ceil(template.days)}` });
        continue;
      }
      const future = to > nowMs;
      if (future) freeDays += 1;
      cells.push({ cls: future ? 'fp-free' : '', text: '', hint: future ? 'свободна — ресурс под нового клиента' : '' });
    }
    return { cells, freeDays, template };
  };

  const allRowsData = vehicles.map(vehicle => ({ vehicle, ...rowCells(vehicle) }))
    .sort((a, b) => b.freeDays - a.freeDays || a.vehicle.plate.localeCompare(b.vehicle.plate, 'ru'));
  const query = flt.query.trim().toLowerCase();
  const rowsData = allRowsData.filter(row =>
    (!query || `${row.vehicle.plate} ${row.vehicle.driver_name || ''} ${row.vehicle.type_name || ''}`
      .toLowerCase().includes(query)) &&
    (flt.round === '' || (flt.round === 'none' ? !row.template : row.template?.key === flt.round)) &&
    (!flt.freeOnly || (row.freeDays >= 10 && !row.template)));

  // Итог по дням: занято рейсами / прогноз / свободно.
  const totals = Array.from({ length: days }, (_, i) => ({ busy: 0, free: 0 }));
  for (const row of rowsData) {
    row.cells.forEach((cell, i) => {
      if (cell.cls === 'fp-free') totals[i].free += 1;
      else if (cell.cls && cell.cls !== 'fp-fore') totals[i].busy += 1;
    });
  }

  const [year, monthNum] = plan.month.split('-').map(Number);
  const firstWd = new Date(monthStartMs).getUTCDay();
  const todayIso = new Date().toISOString().slice(0, 10);
  const dayHead = Array.from({ length: days }, (_, i) => {
    const wd = (firstWd + i) % 7;
    const isToday = `${plan.month}-${String(i + 1).padStart(2, '0')}` === todayIso;
    return `<th class="${wd === 0 || wd === 6 ? 'muted' : ''}"
      style="text-align:center;min-width:26px${isToday ? ';background:color-mix(in srgb, #c99a2e 25%, transparent)' : ''}">${i + 1}<br><small>${WD[wd]}</small></th>`;
  }).join('');

  const freeTotal = rowsData.filter(row => row.freeDays >= 10 && !row.template).length;
  const shiftMonth = delta =>
    new Date(Date.UTC(year, monthNum - 1 + delta, 1)).toISOString().slice(0, 7);

  // Полотно — во вкладку (context.planTarget) или в fullscreen-модалку
  // (кнопка у логиста, как раньше); вложенные диалоги всегда модалки.
  // Вкладка запоминает месяц и фильтры.
  if (context.planTarget && context.state) {
    context.state.fleetMonth = plan.month;
    context.state.fleetFlt = flt;
  }
  const renderCanvas = html => context.planTarget
    ? (context.planTarget.innerHTML = html)
    : context.showModal(html, 'fullscreen');
  renderCanvas(`<h2>🚛 План парка — ${MONTHS[monthNum - 1]} ${year}</h2>
    <div class="console" style="margin:8px 0">
      <button type="button" class="button ghost small" id="fpPrev">←</button>
      <button type="button" class="button ghost small" id="fpToday" title="Вернуться к текущему месяцу">Сегодня</button>
      <button type="button" class="button ghost small" id="fpNext">→</button>
      <input id="fpQuery" class="block-search" placeholder="🔍 номер, водитель, тип" value="${escapeHtml(flt.query)}"
        style="width:170px" autocomplete="off">
      <select id="fpRound" title="Фильтр по назначенному кругу">
        <option value="">— все круги —</option>
        <option value="none" ${flt.round === 'none' ? 'selected' : ''}>без круга</option>
        ${ROUND_TEMPLATES.map(item => `<option value="${item.key}" ${flt.round === item.key ? 'selected' : ''}>${escapeHtml(item.name.split(' · ')[0])}</option>`).join('')}
      </select>
      <label class="checkline" style="margin:0"><input type="checkbox" id="fpFreeOnly"
        ${flt.freeOnly ? 'checked' : ''}> 🟢 только резерв</label>
      <span class="filter-sum" style="margin-left:auto">машин ${rowsData.length}${rowsData.length !== allRowsData.length ? ` / ${allRowsData.length}` : ''}
        · 🟢 резерв под новых клиентов: <b>${freeTotal}</b> (10+ свободных дней без круга)</span>
    </div>
    <p class="muted" style="margin:0 0 8px">Ячейка: синяя — рейс в плане, зелёная — в пути,
      тёмная — выгружен, серая — диспозиция, точка — прогноз по назначенному кругу,
      <b>жёлтая — свободный день</b> (ресурс под новых клиентов). Колонка «Круг» —
      типовой цикл машины: по нему считается прогноз и утренняя стыковка.
      Машины отсортированы по свободным дням — резерв сверху.</p>
    <div class="table-wrap" style="max-height:62vh;overflow:auto"><table style="font-size:11px" class="fleet-plan plan-grid">
      <tr class="plan-sticky-head"><th class="plan-fix" style="min-width:90px">ТС</th><th class="plan-fix2" style="left:90px;min-width:120px">Круг</th><th title="Свободных дней до конца месяца">🟢</th>${dayHead}</tr>
      <tr class="plan-totals" style="font-weight:700"><td colspan="3" class="plan-fix" style="top:34px">Занято рейсами</td>${totals.map(t =>
    `<td style="text-align:center;top:34px">${t.busy || ''}</td>`).join('')}</tr>
      <tr class="plan-totals" style="font-weight:700"><td colspan="3" class="plan-fix" style="top:58px">🟢 Свободно</td>${totals.map(t =>
    `<td style="text-align:center;top:58px;${t.free ? 'color:#c99a2e' : ''}">${t.free || ''}</td>`).join('')}</tr>
      ${rowsData.map(row => `<tr>
        <td class="mono plan-fix" style="white-space:nowrap"><span class="vlink" data-fp-veh="${row.vehicle.id}">${escapeHtml(row.vehicle.plate)}</span></td>
        <td class="plan-fix2" style="white-space:nowrap;left:90px">${canEdit ? `<select data-fp-round="${row.vehicle.id}" style="max-width:118px;font-size:10px">
            <option value="">— без круга —</option>
            ${ROUND_TEMPLATES.map(item => `<option value="${item.key}" ${row.template?.key === item.key ? 'selected' : ''}>${escapeHtml(item.name.split(' · ')[0])} · ${escapeHtml(item.name.split(' · ')[1] || '')}</option>`).join('')}
          </select>` : escapeHtml(row.template?.name || '—')}</td>
        <td style="text-align:center;${row.freeDays >= 10 ? 'color:#c99a2e;font-weight:700' : ''}">${row.freeDays || ''}</td>
        ${row.cells.map((cell, i) => `<td class="${cell.cls}" title="${escapeHtml(`${row.vehicle.plate}: ${cell.hint}`)}"
          ${cell.cls ? `data-fp-cell="${row.vehicle.id}|${i + 1}" style="text-align:center;cursor:pointer"` : 'style="text-align:center"'}>${cell.text}</td>`).join('')}
      </tr>`).join('')}
    </table></div>
    ${context.planTarget ? '' : '<div class="modal-actions"><button type="button" class="button ghost" data-close>Закрыть</button></div>'}`);

  const rerender = (newMonth = plan.month) => fleetPlanDialog(context, newMonth, {
    query: document.getElementById('fpQuery')?.value ?? flt.query,
    round: document.getElementById('fpRound')?.value ?? flt.round,
    freeOnly: document.getElementById('fpFreeOnly')?.checked ?? flt.freeOnly
  });
  document.getElementById('fpPrev').onclick = () => rerender(shiftMonth(-1));
  document.getElementById('fpNext').onclick = () => rerender(shiftMonth(1));
  document.getElementById('fpToday').onclick = () => rerender(new Date().toISOString().slice(0, 7));
  let fpTimer = null;
  document.getElementById('fpQuery').addEventListener('input', () => {
    clearTimeout(fpTimer); fpTimer = setTimeout(() => rerender(), 400);
  });
  document.getElementById('fpRound').addEventListener('change', () => rerender());
  document.getElementById('fpFreeOnly').addEventListener('change', () => rerender());
  document.querySelectorAll('[data-fp-round]').forEach(select =>
    select.addEventListener('change', async () => {
      try {
        await api('/api/fleet-plan/round', { method: 'POST', body: JSON.stringify({
          vehicleId: select.dataset.fpRound, roundKey: select.value }) });
        toast(select.value ? 'Круг назначен — прогноз перестроен' : 'Круг снят');
        fleetPlanDialog(context, plan.month, flt);
      } catch (error) { toast(error.message, 'error'); }
    }));
  // Клик по ячейке — день машины (рейсы, диспозиции, свободный день);
  // по госномеру — карточка машины с кругом и рейсами месяца.
  document.querySelectorAll('[data-fp-cell]').forEach(cell =>
    cell.addEventListener('click', () => {
      const [vehicleId, day] = cell.dataset.fpCell.split('|');
      const row = rowsData.find(item => item.vehicle.id === vehicleId);
      if (row) fpDayDialog(context, plan, row.vehicle, Number(day), row.template);
    }));
  document.querySelectorAll('[data-fp-veh]').forEach(link =>
    link.addEventListener('click', () => {
      const row = rowsData.find(item => item.vehicle.id === link.dataset.fpVeh);
      if (row) fpVehicleDialog(context, plan, row, flt);
    }));
}
