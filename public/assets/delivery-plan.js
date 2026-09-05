// «📅 План вывоза» — визуальный график вывоза грузов от клиентов на месяц:
// строки — клиентские плечи (недельная сетка слотов), колонки — дни месяца.
// Ячейка: план (рейсов) + факт цветом (заявка внесена → ТС назначено →
// выгружено). Итоги по дням: рейсы план/факт, машин занято (оценка по
// циклам плеч), выручка. «Заполнить из истории» строит сетку из регулярных
// плеч за 60 суток; дальше её правят продажи под договорённости.
import { api, escapeHtml, formatDateTime, money, toast, syncPlanStickyTops, apiConfirmable } from './api.js';

const WD = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

// Заявки клиента по плечу в конкретный день: сопоставление как в facts
// сервера — окно погрузки в МСК-день.
function ordersOfCell(data, row, monthIso, day) {
  const dayIso = `${monthIso}-${String(day).padStart(2, '0')}`;
  return (data.orders || []).filter(order =>
    order.customer_name === row.customer &&
    order.from_zone_id === row.fromZoneId && order.to_zone_id === row.toZoneId &&
    !['cancelled', 'rejected'].includes(order.status) &&
    new Date(Date.parse(order.window_from) + 3 * 3_600_000).toISOString().slice(0, 10) === dayIso);
}

// Подпись плеча «от субъекта к субъекту»: субъект РФ — из адресов последней
// заявки плеча (lastPoints), геозоны уходят на второй план мелкой строкой.
function legRegions(context, plan, row) {
  const addresses = context.state?.data?.reference?.addresses || [];
  const last = (plan.lastPoints || {})[`${row.customer}|${row.fromZoneId}|${row.toZoneId}`] || {};
  const regionOf = (addressId, point) => {
    const byId = addressId ? addresses.find(item => item.id === addressId)?.region : '';
    if (byId) return byId;
    const tail = String(point || '').match(/([А-ЯЁ][а-яё]+(?:ая|ий))\s+(обл|область|край|респ)\.?\s*$/);
    return tail ? `${tail[1]} ${tail[2]}` : '';
  };
  const from = regionOf(last.fromAddressId, last.fromPoint);
  const to = regionOf(last.toAddressId, last.toPoint);
  return (from || to) ? `${from || row.leg.split('→')[0]} → ${to || row.leg.split('→')[1]}` : '';
}

const legLabelHtml = (context, plan, row) => {
  const regions = legRegions(context, plan, row);
  return regions
    ? `${escapeHtml(regions)}<small class="muted" style="display:block;font-weight:400;opacity:.75">зоны: ${escapeHtml(row.leg)}</small>`
    : escapeHtml(row.leg);
};

const ORDER_STATE = (order, data) => {
  if (!order.trip_id) return ['⚠ без ТС', 'badge bad'];
  const trip = (data.trips || []).find(item => item.id === order.trip_id);
  if (!trip || trip.status === 'rejected') return ['⚠ без ТС', 'badge bad'];
  if (['unloaded', 'done', 'paid'].includes(trip.status)) return [`✓ выгружен · ${trip.vehicle_plate}`, 'badge ok'];
  if (trip.status === 'run') return [`в пути · ${trip.vehicle_plate}`, 'badge'];
  return [`ТС ${trip.vehicle_plate}`, 'badge'];
};

// Диалог ячейки дня: взятые заявки (клик — правка) и потенциал слота.
function dayCellDialog(context, plan, row, day, flt) {
  const data = context.state?.data || { orders: [], trips: [] };
  const taken = ordersOfCell(data, row, plan.month, day);
  const planned = row.week[(plan.firstWeekday + day - 1) % 7] || 0;
  const gap = Math.max(0, Math.round(planned) - taken.length);
  const canEdit = context.can('orders:write') || context.can('shifts:write');
  context.showModal(`<h2>${escapeHtml(row.customer.slice(0, 40))}</h2>
    <p class="muted">${escapeHtml(row.leg)} · ${day} ${MONTHS[Number(plan.month.slice(5, 7)) - 1]}
      · план слота: ${planned ? Math.round(planned * 100) / 100 : 0} · взято: ${taken.length}
      · ставка сетки ${money(row.rate)}</p>
    <div class="scolh">Взятые рейсы <span>${taken.length}</span></div>
    <div class="list">${taken.map(order => {
      const [label, cls] = ORDER_STATE(order, data);
      return `<div class="list-item" data-dpl-open-order="${order.id}" style="cursor:pointer"
          title="Открыть заявку: окно, ставка, пункты — с возможностью правки">
        <span style="flex:1;min-width:0">${order.order_no ? `№ ${escapeHtml(String(order.order_no))} · ` : ''}
          окно ${formatDateTime(order.window_from)}
          <small class="muted" style="display:block">${escapeHtml((order.from_point || '').slice(0, 34))} →
            ${escapeHtml((order.to_point || '').slice(0, 34))}</small></span>
        <span class="${cls}">${escapeHtml(label)}</span>
        <b>${money(order.rate_vat)}</b></div>`;
    }).join('') || '<p class="muted">Заявок на этот день нет.</p>'}</div>
    ${gap > 0 ? `<div class="scolh" style="margin-top:8px">Потенциал</div>
      <p class="muted">Сетка ждёт ещё <b>${gap}</b> ${gap === 1 ? 'рейс' : 'рейса(ов)'} на
        ${money(gap * row.rate)} — договоритесь с клиентом и внесите заявку.</p>` : ''}
    <div class="modal-actions">
      ${canEdit && gap > 0 ? `<button type="button" class="button" id="dplCellNew">+ Заявка из плана</button>` : ''}
      <button type="button" class="button ghost" data-close>Закрыть</button>
    </div>`);
  document.getElementById('dplCellNew')?.addEventListener('click', () =>
    orderFromSlotDialog(context, plan, row, day, flt));
  document.querySelectorAll('[data-dpl-open-order]').forEach(item =>
    item.addEventListener('click', async () => {
      const order = (data.orders || []).find(entry => entry.id === item.dataset.dplOpenOrder);
      if (!order) return;
      const { editOrderDialog } = await import('./sales.js');
      editOrderDialog(order, data, { showModal: context.showModal, closeModal: context.closeModal,
        onReload: context.onReload || (() => deliveryPlanDialog(context, plan.month, flt)) });
    }));
}

// Карточка клиента в сетке: все его плечи с планом, фактом и суммами;
// «✎» редактирует слоты плеча, «📇» открывает CRM-карточку.
function customerLegsDialog(context, plan, customer, rowList, helpers, flt) {
  const { planOf, factOf, gapOf, daysInMonth } = helpers;
  const legs = rowList.filter(row => row.customer === customer);
  const monthOf = row => {
    let planN = 0; let factN = 0; let factRv = 0; let gapN = 0;
    for (let day = 1; day <= daysInMonth; day += 1) {
      planN += planOf(row, day);
      gapN += gapOf(row, day);
      const fact = factOf(row, day);
      if (fact) { factN += fact.n; factRv += fact.rv; }
    }
    return { planN, factN, factRv, gapN, gapRv: gapN * row.rate, planRv: planN * row.rate };
  };
  const totals = legs.map(monthOf);
  const sum = key => totals.reduce((acc, item) => acc + item[key], 0);
  const canEdit = context.can('orders:write') || context.can('shifts:write');
  context.showModal(`<h2>${escapeHtml(customer)}</h2>
    <p class="muted">Плечи клиента в сетке за ${MONTHS[Number(plan.month.slice(5, 7)) - 1]}:
      план <b>${Math.round(sum('planN'))}</b> рейсов на <b>${money(Math.round(sum('planRv')))}</b>
      · взято <b>${sum('factN')}</b> на <b>${money(Math.round(sum('factRv')))}</b></p>
    ${sum('gapN') ? `<p class="task-balance-line bad" style="margin:0 0 8px">💰 Не взято до конца
      месяца: <b>${sum('gapN')}</b> рейс. на <b>${money(Math.round(sum('gapRv')))}</b> —
      задача продаж: договориться и внести заявки (клик по жёлтым ячейкам строки клиента).</p>` : ''}
    <div class="table-wrap"><table>
      <thead><tr><th>Плечо</th><th class="num">Ставка</th><th class="num">План, рейс.</th>
        <th class="num">Взято</th><th class="num" title="Незакрытые будущие слоты">Не взято</th>
        <th class="num">План, ₽</th><th class="num">Факт, ₽</th><th></th></tr></thead>
      <tbody>${legs.map((row, index) => `<tr>
        <td>${legLabelHtml(context, plan, row)}</td>
        <td class="num">${money(row.rate)}</td>
        <td class="num">${Math.round(totals[index].planN)}</td>
        <td class="num">${totals[index].factN}</td>
        <td class="num" style="${totals[index].gapN ? 'color:var(--bad);font-weight:700' : ''}">${totals[index].gapN || ''}</td>
        <td class="num">${money(Math.round(totals[index].planRv))}</td>
        <td class="num">${money(Math.round(totals[index].factRv))}</td>
        <td>${canEdit ? `<button type="button" class="button ghost small" data-dpl-cust-slot="${rowList.indexOf(row)}"
          title="Слоты недели и ставка плеча">✎</button>` : ''}</td>
      </tr>`).join('')}</tbody>
    </table></div>
    <div class="modal-actions">
      ${canEdit ? '<button type="button" class="button" id="dplNewLeg" title="Новое плечо клиента в сетке: зоны, ставка, слоты недели">+ Плечо</button>' : ''}
      <button type="button" class="button ghost" id="dplCustCard" title="CRM: контакты, касания, заказы">📇 Карточка клиента</button>
      <button type="button" class="button ghost" data-close>Закрыть</button>
    </div>`, 'wide');
  document.getElementById('dplNewLeg')?.addEventListener('click', () =>
    newLegDialog(context, plan, customer, flt));
  document.getElementById('dplCustCard').onclick = async () => {
    const { customerCardDialog } = await import('./customer-card.js');
    customerCardDialog(customer, context);
  };
  document.querySelectorAll('[data-dpl-cust-slot]').forEach(button =>
    button.addEventListener('click', () =>
      slotEditor(context, plan, rowList[Number(button.dataset.dplCustSlot)], flt)));
}

// Новое плечо клиента: зоны, ставка и слоты недели — тем же API, что
// редактор слотов. Появится строкой сетки после сохранения.
function newLegDialog(context, plan, customer, flt) {
  const zones = context.state?.data?.reference?.zones || [];
  const zoneOptions = zones.map(zone =>
    `<option value="${zone.id}">${escapeHtml(zone.name)}</option>`).join('');
  context.showModal(`<h2>+ Плечо · ${escapeHtml(customer.slice(0, 34))}</h2>
    <form id="dplNewLegForm">
      <div class="form-grid">
        <label class="field">Откуда (зона)<select name="fromZoneId" required>${zoneOptions}</select></label>
        <label class="field">Куда (зона)<select name="toZoneId" required>${zoneOptions}</select></label>
      </div>
      <div class="form-grid" style="grid-template-columns:repeat(4,1fr)">
        ${[1, 2, 3, 4, 5, 6, 0].map(weekday => `<label class="field">${WD[weekday]}
          <input name="d${weekday}" type="number" min="0" step="any" value="0"></label>`).join('')}
        <label class="field">Ставка, ₽<input name="rate" type="number" min="0" required></label>
      </div>
      <div class="modal-actions">
        <button type="button" class="button ghost" data-close>Отмена</button>
        <button class="button">Создать плечо</button>
      </div>
    </form>`);
  document.getElementById('dplNewLegForm').onsubmit = async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (form.get('fromZoneId') === form.get('toZoneId') &&
        !confirm('Зоны погрузки и выгрузки совпадают (локалка). Создать?')) return;
    try {
      for (let weekday = 0; weekday < 7; weekday += 1) {
        await api('/api/delivery-plan/slot', { method: 'POST', body: JSON.stringify({
          customer, fromZoneId: form.get('fromZoneId'), toZoneId: form.get('toZoneId'),
          weekday, perDay: Number(form.get(`d${weekday}`)) || 0,
          rate: Number(form.get('rate')) || 0, transitHours: 24
        }) });
      }
      toast('Плечо создано — строка появилась в сетке');
      deliveryPlanDialog(context, plan.month, flt);
    } catch (error) { toast(error.message, 'error'); }
  };
}
const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
  'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];

export async function deliveryPlanDialog(context, month = '', filters = {}, cachedPlan = null) {
  // Кеш плана: правка фильтров и поиска перерисовывает полотно из уже
  // загруженных данных — сеть только при смене месяца. Раньше каждый символ
  // поиска ходил в API и пересоздавал поле: «лагает и слетает ввод».
  let plan = cachedPlan;
  if (!plan) {
    try {
      plan = await api(`/api/delivery-plan${month ? `?month=${month}` : ''}`);
    } catch (error) { toast(error.message, 'error'); return; }
  }
  const { daysInMonth, firstWeekday, slots, facts } = plan;
  const canEdit = context.can('orders:write') || context.can('shifts:write');
  // Рабочее поле: поиск по клиенту, фильтр зоны плеча, «только с дырами».
  const flt = { query: '', zone: '', gapsOnly: false, ...filters };

  // Слоты группируются в строки «клиент + плечо» с недельным профилем.
  const rows = new Map();
  for (const slot of slots) {
    const key = `${slot.customer_name}|${slot.from_zone_id}|${slot.to_zone_id}`;
    if (!rows.has(key)) {
      rows.set(key, { customer: slot.customer_name, fromZoneId: slot.from_zone_id,
        toZoneId: slot.to_zone_id, leg: `${slot.from_name}→${slot.to_name}`,
        week: new Array(7).fill(0), rate: 0, transit: 24 });
    }
    const row = rows.get(key);
    row.week[slot.weekday] = slot.per_day;
    row.rate = slot.rate || row.rate;
    row.transit = slot.transit_hours || row.transit;
  }
  const allRows = [...rows.values()].sort((a, b) =>
    (b.week.reduce((s, v) => s + v, 0) * b.rate) - (a.week.reduce((s, v) => s + v, 0) * a.rate));
  const query = flt.query.trim().toLowerCase();
  const rowList = allRows.filter(row =>
    (!query || row.customer.toLowerCase().includes(query)) &&
    (!flt.zone || row.leg.includes(flt.zone)));

  const weekdayOf = day => (firstWeekday + day - 1) % 7;
  const planOf = (row, day) => row.week[weekdayOf(day)];
  const factOf = (row, day) => facts[`${row.customer}|${row.fromZoneId}|${row.toZoneId}|${day}`];

  // Итоги по дням и месяцу.
  const dayTotals = [];
  for (let day = 1; day <= daysInMonth; day += 1) {
    let planN = 0; let factN = 0; let busy = 0; let planRv = 0; let factRv = 0;
    for (const row of rowList) {
      const p = planOf(row, day);
      planN += p; planRv += p * row.rate;
      busy += p * (row.transit + 8) / 24;
      const fact = factOf(row, day);
      if (fact) { factN += fact.n; factRv += fact.rv; }
    }
    dayTotals.push({ planN, factN, busy, planRv, factRv, gapN: 0 });
  }
  const monthPlanN = dayTotals.reduce((s, d) => s + d.planN, 0);
  const monthPlanRv = dayTotals.reduce((s, d) => s + d.planRv, 0);
  const monthFactN = dayTotals.reduce((s, d) => s + d.factN, 0);
  const monthFactRv = dayTotals.reduce((s, d) => s + d.factRv, 0);
  // «Дыра» — недобор будущих дней: план есть, заявок меньше плана.
  // Прошедшие дни не в счёт: их уже не закрыть, это отчёт, а не задача.
  const todayIso = new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
  const dayIso = day => `${plan.month}-${String(day).padStart(2, '0')}`;
  const gapOf = (row, day) => dayIso(day) < todayIso ? 0
    : Math.max(0, Math.round(planOf(row, day)) - (factOf(row, day)?.n || 0));
  let gapN = 0; let gapRv = 0;
  for (const row of rowList) {
    for (let day = 1; day <= daysInMonth; day += 1) {
      const gap = gapOf(row, day);
      gapN += gap; gapRv += gap * row.rate;
      dayTotals[day - 1].gapN += gap;
    }
  }
  // Цель месяца хранится без НДС, ставки сетки — с НДС: приводим к одному
  // знаменателю, иначе сравнение врёт на 22%.
  const targetVat = (plan.targetNet || 0) * 1.22;
  const gridAgeDays = plan.gridUpdatedAt
    ? Math.floor((Date.now() - Date.parse(String(plan.gridUpdatedAt).replace(' ', 'T') + 'Z')) / 86_400_000)
    : null;

  const dayHead = Array.from({ length: daysInMonth }, (_, i) => {
    const wd = weekdayOf(i + 1);
    const isToday = dayIso(i + 1) === todayIso;
    return `<th style="text-align:center;min-width:30px${isToday ? ';background:color-mix(in srgb, #c99a2e 25%, transparent)' : ''}"
      class="${wd === 0 || wd === 6 ? 'muted' : ''}">${i + 1}<br><small>${WD[wd]}</small></th>`;
  }).join('');

  let totalRowIndex = 0;
  const totalRow = (label, pick, fmt = v => v ? Math.round(v) : '', hint = '') => {
    const top = 34 + totalRowIndex * 24;
    totalRowIndex += 1;
    return `<tr class="plan-totals" style="font-weight:700"><td colspan="3" class="plan-fix" style="top:${top}px"
      ${hint ? `title="${escapeHtml(hint)}"` : ''}>${label}</td>${dayTotals.map(d =>
      `<td style="text-align:center;top:${top}px">${fmt(pick(d))}</td>`).join('')}</tr>`;
  };

  const cellHtml = (row, rowIndex, day) => {
    const p = planOf(row, day);
    const fact = factOf(row, day);
    const gap = gapOf(row, day);
    const stageClass = fact
      ? fact.stage >= 3 ? 'background:#20624f;color:#fff'
        : fact.stage >= 2 ? 'background:#2e7d6b;color:#fff'
          : 'background:#3b6ea5;color:#fff'
      : p ? 'background:#fff3cd' : '';
    // План в ячейке — математическое округление (0,5 → 1); редкие слоты
    // (<0,5 рейса в день) остаются жёлтыми без цифры, точное значение —
    // в подсказке при наведении.
    const text = fact ? fact.n : p ? (Math.round(p) || '') : '';
    // Любая ячейка с планом или фактом кликабельна: диалог дня показывает
    // взятые рейсы (клик — правка заявки) и потенциал слота с кнопкой
    // «+ Заявка из плана». Пунктир остаётся меткой незакрытого будущего.
    const clickable = Boolean(fact || p);
    const hint = `${row.customer} · ${row.leg} · ${day}.${plan.month.slice(5, 7)}: план ${p ? Math.round(p * 100) / 100 : 0}` +
      (fact ? `, заявок ${fact.n} (${['', 'внесена', 'ТС назначено', 'выгружено'][fact.stage]}) на ${money(Math.round(fact.rv))}` : ', заявок нет') +
      (clickable ? ' — клик: взятые рейсы и потенциал дня' : '');
    return `<td style="text-align:center;${stageClass}${clickable ? ';cursor:pointer' : ''}${canEdit && gap > 0 ? ';outline:1px dashed #c99a2e;outline-offset:-2px' : ''}"
      ${clickable ? `data-dpl-cell="${rowIndex}|${day}"` : ''} title="${escapeHtml(hint)}">${text}</td>`;
  };

  const rowHasGap = row => {
    for (let day = 1; day <= daysInMonth; day += 1) if (gapOf(row, day) > 0) return true;
    return false;
  };
  const shownRows = flt.gapsOnly ? rowList.filter(rowHasGap) : rowList;
  const bodyRows = shownRows.map(row => { const index = rowList.indexOf(row); return `<tr>
    <td class="plan-fix" style="white-space:nowrap;max-width:150px;min-width:150px;overflow:hidden;text-overflow:ellipsis">
      <b data-dpl-cust="${escapeHtml(row.customer)}" style="cursor:pointer"
        title="Плечи клиента: план, взято, суммы — с правкой слотов">${escapeHtml(row.customer)}</b></td>
    <td class="plan-fix2" style="white-space:nowrap;left:150px">${legLabelHtml(context, plan, row)}</td>
    <td style="white-space:nowrap">${money(row.rate)}${canEdit ? ` <button class="button ghost small" data-slot-edit="${index}" title="Слоты недели и ставка">✎</button>` : ''}</td>
    ${Array.from({ length: daysInMonth }, (_, i) => cellHtml(row, index, i + 1)).join('')}
  </tr>`; }).join('');

  const [year, monthNum] = plan.month.split('-').map(Number);
  const shiftMonth = delta => {
    const date = new Date(Date.UTC(year, monthNum - 1 + delta, 1));
    return date.toISOString().slice(0, 7);
  };

  // Полотно рендерится либо во вкладку (context.planTarget — полноценное
  // рабочее поле), либо в fullscreen-модалку (кнопки в ролях, как раньше).
  // Вложенные редакторы (слоты, заявка из слота) всегда модалки. Вкладка
  // запоминает месяц и фильтры — тихое обновление данных их не сбрасывает.
  if (context.planTarget && context.state) {
    context.state.deliveryMonth = plan.month;
    context.state.deliveryFlt = flt;
  }
  const renderCanvas = html => context.planTarget
    ? (context.planTarget.innerHTML = html)
    : context.showModal(html, 'fullscreen');
  renderCanvas(`<h2>📅 План вывоза — ${MONTHS[monthNum - 1]} ${year}</h2>
    <div class="console" style="margin:8px 0">
      <button type="button" class="button ghost small" id="dplPrev">←</button>
      <button type="button" class="button ghost small" id="dplToday" title="Вернуться к текущему месяцу">Сегодня</button>
      <button type="button" class="button ghost small" id="dplNext">→</button>
      <input id="dplQuery" class="block-search" placeholder="🔍 клиент" value="${escapeHtml(flt.query)}"
        style="width:150px" autocomplete="off">
      <select id="dplZone" title="Плечи, где зона участвует в маршруте">
        <option value="">— все зоны —</option>
        ${[...new Set(slots.flatMap(slot => [slot.from_name, slot.to_name]))].sort()
    .map(name => `<option ${flt.zone === name ? 'selected' : ''}>${escapeHtml(name)}</option>`).join('')}
      </select>
      <label class="checkline" style="margin:0"><input type="checkbox" id="dplGapsOnly"
        ${flt.gapsOnly ? 'checked' : ''}> только с дырами</label>
      ${canEdit ? `<button type="button" class="button small" id="dplSeed"
        title="Построить/обновить сетку слотов из регулярных плеч за 60 суток (клиент+направление ≥1 рейса в неделю)">⚙ Заполнить из истории</button>` : ''}
      <span class="filter-sum" style="margin-left:auto">плеч ${shownRows.length}${shownRows.length !== allRows.length ? ` / ${allRows.length}` : ''}
        · план ${Math.round(monthPlanN)} рейсов · ${money(Math.round(monthPlanRv))}
        · факт ${monthFactN} заявок · ${money(Math.round(monthFactRv))}${gridAgeDays != null && gridAgeDays > 10
    ? ` · <span style="color:var(--warn,#c99a2e)" title="Сетка слотов давно не обновлялась из истории — «⚙ Заполнить из истории» (ручные плечи не тронет); пересев также идёт сам в ночь на понедельник">⚙ сетке ${gridAgeDays} дн</span>` : ''}</span>
    </div>
    ${gapN > 0 ? `<p style="margin:0 0 6px;padding:7px 10px;border-radius:8px;background:color-mix(in srgb, #c99a2e 14%, var(--card,#fff));border:1px solid #c99a2e">
      🕳 <b>Не закрыто до конца месяца: ${gapN} рейсов ≈ ${money(Math.round(gapRv))}</b>${targetVat
    ? ` · сетка целиком даёт ${money(Math.round(monthPlanRv))} из цели ${money(Math.round(targetVat))} с НДС (${Math.round(monthPlanRv / targetVat * 100)}%)${monthPlanRv < targetVat
      ? ' — даже полная сетка цель не закрывает: нужны новые клиенты или плечи' : ''}` : ''}
      <br><small class="muted">Пунктирные ячейки — незакрытые слоты будущих дней: клик открывает
      заявку с заполненными клиентом, плечом, днём и ставкой. Это и есть список «кому звонить».</small></p>` : ''}
    <p class="muted" style="margin:0 0 8px">Ячейка: жёлтая — слот без заявки (задача продаж),
      синяя — заявка внесена, зелёная — ТС назначено, тёмная — выгружено. Число в ячейке — факт
      заявок (или план, если заявок нет). «Машин занято» — оценка: рейсы × цикл плеча.</p>
    <div class="table-wrap" style="max-height:62vh;overflow:auto"><table style="font-size:11px" class="plan-grid">
      <tr class="plan-sticky-head"><th class="plan-fix" style="min-width:150px">Клиент</th><th class="plan-fix2" style="left:150px">Плечо</th><th>Ставка</th>${dayHead}</tr>
      ${totalRow('Рейсов план', d => d.planN, undefined,
        'Сколько рейсов в этот день обещает сетка слотов (сумма по всем плечам)')}
      ${totalRow('Заявок факт', d => d.factN, v => v || '',
        'Сколько заявок на этот день уже внесено в планер')}
      ${totalRow('Машин занято (оценка)', d => d.busy, undefined,
        'Оценка занятого парка: рейсы дня × длительность цикла плеча (транзит + 8 ч на операции) — сколько машин «съест» этот день')}
      ${totalRow('Выручка план, т₽', d => d.planRv / 1000, undefined,
        'План выручки дня по ставкам сетки, тысяч рублей с НДС')}
      ${totalRow('🕳 Дыра (не закрыто)', d => d.gapN, v => v || '',
        'План минус внесённые заявки по БУДУЩИМ дням: сколько рейсов ещё не законтрактовано — задача продаж «кому звонить». Прошедшие дни не считаются — их уже не закрыть')}
      ${bodyRows || `<tr><td colspan="${daysInMonth + 3}" class="muted">Сетка пуста — нажмите «⚙ Заполнить из истории».</td></tr>`}
    </table></div>
    ${context.planTarget ? '' : '<div class="modal-actions"><button type="button" class="button ghost" data-close>Закрыть</button></div>'}`);

  syncPlanStickyTops();

  const rerender = (newMonth = plan.month) => deliveryPlanDialog(context, newMonth, {
    query: document.getElementById('dplQuery')?.value ?? flt.query,
    zone: document.getElementById('dplZone')?.value ?? flt.zone,
    gapsOnly: document.getElementById('dplGapsOnly')?.checked ?? flt.gapsOnly
  }, newMonth === plan.month ? plan : null);
  document.getElementById('dplPrev').onclick = () => rerender(shiftMonth(-1));
  document.getElementById('dplNext').onclick = () => rerender(shiftMonth(1));
  document.getElementById('dplToday').onclick = () => rerender(new Date().toISOString().slice(0, 7));
  let dplTimer = null;
  document.getElementById('dplQuery').addEventListener('input', () => {
    clearTimeout(dplTimer);
    dplTimer = setTimeout(async () => {
      // Возврат фокуса и каретки: перерисовка пересоздаёт поле поиска.
      const el = document.getElementById('dplQuery');
      const caret = el?.selectionStart ?? 0;
      await rerender();
      const again = document.getElementById('dplQuery');
      if (again) {
        again.focus();
        const position = Math.min(caret, again.value.length);
        again.setSelectionRange(position, position);
      }
    }, 350);
  });
  document.getElementById('dplZone').addEventListener('change', () => rerender());
  document.getElementById('dplGapsOnly').addEventListener('change', () => rerender());
  // Клик по ячейке — диалог дня: взятые рейсы и потенциал; по имени
  // клиента — его плечи с суммами и правкой слотов.
  document.querySelectorAll('[data-dpl-cell]').forEach(cell =>
    cell.addEventListener('click', () => {
      const [rowIndex, day] = cell.dataset.dplCell.split('|');
      dayCellDialog(context, plan, rowList[Number(rowIndex)], Number(day), flt);
    }));
  document.querySelectorAll('[data-dpl-cust]').forEach(cell =>
    cell.addEventListener('click', () =>
      customerLegsDialog(context, plan, cell.dataset.dplCust, rowList,
        { planOf, factOf, gapOf, daysInMonth }, flt)));
  if (canEdit) {
    const seed = document.getElementById('dplSeed');
    if (seed) {
      seed.onclick = async () => {
        try {
          const { created } = await api('/api/delivery-plan/seed', { method: 'POST', body: '{}' });
          toast(`Сетка обновлена из истории: слотов ${created}`);
          deliveryPlanDialog(context, plan.month, flt);
        } catch (error) { toast(error.message, 'error'); }
      };
    }
    document.querySelectorAll('[data-slot-edit]').forEach(button =>
      button.addEventListener('click', () => slotEditor(context, plan, rowList[Number(button.dataset.slotEdit)], flt)));
  }
}

// Мини-форма плеча: рейсов в каждый день недели + ставка.
function slotEditor(context, plan, row, flt = {}) {
  context.showModal(`<h2>Слоты недели</h2>
    <p class="muted">${escapeHtml(row.customer)} · ${escapeHtml(row.leg)} — рейсов в день
      (0 — слота нет); ставка применяется ко всем слотам плеча.</p>
    <form id="dplSlotForm">
      <div class="form-grid" style="grid-template-columns:repeat(4,1fr)">
        ${[1, 2, 3, 4, 5, 6, 0].map(weekday => `<label class="field">${WD[weekday]}
          <input name="d${weekday}" type="number" min="0" step="any" value="${row.week[weekday] || 0}"></label>`).join('')}
        <label class="field">Ставка, ₽<input name="rate" type="number" min="0" value="${Math.round(row.rate)}"></label>
      </div>
      <div class="modal-actions">
        <button type="button" class="button ghost" data-close>Отмена</button>
        <button class="button">Сохранить</button>
      </div>
    </form>`);
  document.getElementById('dplSlotForm').onsubmit = async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      for (let weekday = 0; weekday < 7; weekday += 1) {
        await api('/api/delivery-plan/slot', { method: 'POST', body: JSON.stringify({
          customer: row.customer, fromZoneId: row.fromZoneId, toZoneId: row.toZoneId,
          weekday, perDay: Number(form.get(`d${weekday}`)) || 0,
          rate: Number(form.get('rate')) || 0, transitHours: row.transit
        }) });
      }
      toast('Слоты сохранены');
      deliveryPlanDialog(context, plan.month, flt);
    } catch (error) { toast(error.message, 'error'); }
  };
}

// «+ Заявка из плана»: слот знает клиента, плечо, день и ставку — менеджеру
// остаётся проверить окно и пункты (подставлены из последней заявки плеча)
// и нажать «Забронировать». Дальше заявка живёт обычным конвейером.
function orderFromSlotDialog(context, plan, row, day, flt = {}) {
  const dayIso = `${plan.month}-${String(day).padStart(2, '0')}`;
  const last = (plan.lastPoints || {})[`${row.customer}|${row.fromZoneId}|${row.toZoneId}`] || {};
  context.showModal(`<form id="dplOrderForm">
    <h2>➕ Заявка из плана вывоза</h2>
    <p class="muted">${escapeHtml(row.customer)} · ${escapeHtml(row.leg)} · ${day}.${plan.month.slice(5, 7)}
      — по слоту сетки. Пункты подставлены из последней заявки этого плеча, проверьте.</p>
    <div class="form-grid" style="grid-template-columns:1fr 1fr">
      <label class="field">Погрузка с<input type="datetime-local" name="windowFrom" value="${dayIso}T08:00" required></label>
      <label class="field">Погрузка по<input type="datetime-local" name="windowTo" value="${dayIso}T20:00" required></label>
      <label class="field" style="grid-column:1/-1">Пункт погрузки
        <input name="fromPoint" value="${escapeHtml(last.fromPoint || '')}" placeholder="город, адрес"></label>
      <label class="field" style="grid-column:1/-1">Пункт выгрузки
        <input name="toPoint" value="${escapeHtml(last.toPoint || '')}" placeholder="город, адрес"></label>
      <label class="field">Ставка с НДС, ₽<input name="rateVat" type="number" min="0" value="${Math.round(row.rate)}"></label>
      <label class="field">Комментарий<input name="comment" maxlength="200" placeholder="необязательно"></label>
    </div>
    <div class="modal-actions">
      <button type="button" class="button ghost" data-close>Отмена</button>
      <button class="button">Забронировать</button>
    </div>
  </form>`);
  document.getElementById('dplOrderForm').onsubmit = async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const created = await apiConfirmable('/api/orders', 'POST', {
        customerName: row.customer,
        fromZoneId: row.fromZoneId, toZoneId: row.toZoneId,
        fromPoint: String(form.get('fromPoint') || '').trim(),
        toPoint: String(form.get('toPoint') || '').trim(),
        fromAddressId: last.fromAddressId || null, toAddressId: last.toAddressId || null,
        windowFrom: new Date(form.get('windowFrom')).toISOString(),
        windowTo: new Date(form.get('windowTo')).toISOString(),
        rateVat: Number(form.get('rateVat')) || 0,
        temperatureMode: last.temperatureMode || '', bodyType: last.bodyType || '',
        comment: String(form.get('comment') || '').trim()
      });
      toast(`Забронировано — заявка № ${created.orderNo} в портфеле`);
      deliveryPlanDialog(context, plan.month, flt);
    } catch (error) { toast(error.message, 'error'); }
  };
}
