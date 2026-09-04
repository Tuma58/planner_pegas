// «🚛 План парка» — сетка машин на месяц, зеркало «Плана вывоза» со стороны
// ресурса: строки — сцепки, колонки — дни, ячейки — рейсы (по зонам),
// диспозиции и прогноз по назначенному кругу (шаблон К1–К8). Внизу — итог
// по дням: занято/свободно. Цель — покрыть сетку минимальным числом машин
// и УВИДЕТЬ высвобождаемый ресурс под новых клиентов, а не искать его по
// Ганту глазами.
import { api, escapeHtml, formatDateTime, toast } from './api.js';
import { ROUND_TEMPLATES, roundByKey } from './rounds.js';

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
        <td class="mono plan-fix" style="white-space:nowrap"><span class="vlink" data-vinfo="${row.vehicle.id}">${escapeHtml(row.vehicle.plate)}</span></td>
        <td class="plan-fix2" style="white-space:nowrap;left:90px">${canEdit ? `<select data-fp-round="${row.vehicle.id}" style="max-width:118px;font-size:10px">
            <option value="">— без круга —</option>
            ${ROUND_TEMPLATES.map(item => `<option value="${item.key}" ${row.template?.key === item.key ? 'selected' : ''}>${escapeHtml(item.name.split(' · ')[0])} · ${escapeHtml(item.name.split(' · ')[1] || '')}</option>`).join('')}
          </select>` : escapeHtml(row.template?.name || '—')}</td>
        <td style="text-align:center;${row.freeDays >= 10 ? 'color:#c99a2e;font-weight:700' : ''}">${row.freeDays || ''}</td>
        ${row.cells.map(cell => `<td class="${cell.cls}" title="${escapeHtml(`${row.vehicle.plate}: ${cell.hint}`)}"
          style="text-align:center">${cell.text}</td>`).join('')}
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
}
