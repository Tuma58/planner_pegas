// «📅 План вывоза» — визуальный график вывоза грузов от клиентов на месяц:
// строки — клиентские плечи (недельная сетка слотов), колонки — дни месяца.
// Ячейка: план (рейсов) + факт цветом (заявка внесена → ТС назначено →
// выгружено). Итоги по дням: рейсы план/факт, машин занято (оценка по
// циклам плеч), выручка. «Заполнить из истории» строит сетку из регулярных
// плеч за 60 суток; дальше её правят продажи под договорённости.
import { api, escapeHtml, money, toast } from './api.js';

const WD = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
  'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];

export async function deliveryPlanDialog(context, month = '', filters = {}) {
  let plan;
  try {
    plan = await api(`/api/delivery-plan${month ? `?month=${month}` : ''}`);
  } catch (error) { toast(error.message, 'error'); return; }
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

  const totalRow = (label, pick, fmt = v => v ? Math.round(v) : '') =>
    `<tr style="font-weight:700"><td colspan="3">${label}</td>${dayTotals.map(d =>
      `<td style="text-align:center;background:var(--panel2,#f2f7f7)">${fmt(pick(d))}</td>`).join('')}</tr>`;

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
    // Незакрытый будущий слот кликабелен: одно нажатие открывает заявку с
    // заполненными клиентом, плечом, окном дня и ставкой — план вывоза
    // из смотрелки становится рабочим списком «кому звонить».
    const clickable = canEdit && gap > 0;
    const hint = `${row.customer} · ${row.leg} · ${day}.${plan.month.slice(5, 7)}: план ${p ? Math.round(p * 100) / 100 : 0}` +
      (fact ? `, заявок ${fact.n} (${['', 'внесена', 'ТС назначено', 'выгружено'][fact.stage]}) на ${money(Math.round(fact.rv))}` : ', заявок нет') +
      (clickable ? ' — клик: внести заявку в этот день' : '');
    return `<td style="text-align:center;${stageClass}${clickable ? ';cursor:pointer;outline:1px dashed #c99a2e;outline-offset:-2px' : ''}"
      ${clickable ? `data-dpl-order="${rowIndex}|${day}"` : ''} title="${escapeHtml(hint)}">${text}</td>`;
  };

  const rowHasGap = row => {
    for (let day = 1; day <= daysInMonth; day += 1) if (gapOf(row, day) > 0) return true;
    return false;
  };
  const shownRows = flt.gapsOnly ? rowList.filter(rowHasGap) : rowList;
  const bodyRows = shownRows.map(row => { const index = rowList.indexOf(row); return `<tr>
    <td style="white-space:nowrap;max-width:190px;overflow:hidden;text-overflow:ellipsis"><b>${escapeHtml(row.customer)}</b></td>
    <td style="white-space:nowrap">${escapeHtml(row.leg)}</td>
    <td style="white-space:nowrap">${money(row.rate)}${canEdit ? ` <button class="button ghost small" data-slot-edit="${index}" title="Слоты недели и ставка">✎</button>` : ''}</td>
    ${Array.from({ length: daysInMonth }, (_, i) => cellHtml(row, index, i + 1)).join('')}
  </tr>`; }).join('');

  const [year, monthNum] = plan.month.split('-').map(Number);
  const shiftMonth = delta => {
    const date = new Date(Date.UTC(year, monthNum - 1 + delta, 1));
    return date.toISOString().slice(0, 7);
  };

  context.showModal(`<h2>📅 План вывоза — ${MONTHS[monthNum - 1]} ${year}</h2>
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
    <div class="table-wrap" style="max-height:62vh;overflow:auto"><table style="font-size:11px">
      <tr><th style="min-width:150px">Клиент</th><th>Плечо</th><th>Ставка</th>${dayHead}</tr>
      ${totalRow('Рейсов план', d => d.planN)}
      ${totalRow('Заявок факт', d => d.factN, v => v || '')}
      ${totalRow('Машин занято (оценка)', d => d.busy)}
      ${totalRow('Выручка план, т₽', d => d.planRv / 1000)}
      ${totalRow('🕳 Дыра (не закрыто)', d => d.gapN, v => v || '')}
      ${bodyRows || `<tr><td colspan="${daysInMonth + 3}" class="muted">Сетка пуста — нажмите «⚙ Заполнить из истории».</td></tr>`}
    </table></div>
    <div class="modal-actions"><button type="button" class="button ghost" data-close>Закрыть</button></div>`,
  'wide');

  const rerender = (newMonth = plan.month) => deliveryPlanDialog(context, newMonth, {
    query: document.getElementById('dplQuery')?.value ?? flt.query,
    zone: document.getElementById('dplZone')?.value ?? flt.zone,
    gapsOnly: document.getElementById('dplGapsOnly')?.checked ?? flt.gapsOnly
  });
  document.getElementById('dplPrev').onclick = () => rerender(shiftMonth(-1));
  document.getElementById('dplNext').onclick = () => rerender(shiftMonth(1));
  document.getElementById('dplToday').onclick = () => rerender(new Date().toISOString().slice(0, 7));
  let dplTimer = null;
  document.getElementById('dplQuery').addEventListener('input', () => {
    clearTimeout(dplTimer); dplTimer = setTimeout(() => rerender(), 400);
  });
  document.getElementById('dplZone').addEventListener('change', () => rerender());
  document.getElementById('dplGapsOnly').addEventListener('change', () => rerender());
  // Клик по незакрытому слоту будущего дня: заявка с заполненным клиентом,
  // плечом, окном дня, ставкой слота и адресами последней заявки плеча.
  document.querySelectorAll('[data-dpl-order]').forEach(cell =>
    cell.addEventListener('click', () => {
      const [rowIndex, day] = cell.dataset.dplOrder.split('|');
      orderFromSlotDialog(context, plan, rowList[Number(rowIndex)], Number(day));
    }));
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
      button.addEventListener('click', () => slotEditor(context, plan, rowList[Number(button.dataset.slotEdit)])));
  }
}

// Мини-форма плеча: рейсов в каждый день недели + ставка.
function slotEditor(context, plan, row) {
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
function orderFromSlotDialog(context, plan, row, day) {
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
      const created = await api('/api/orders', { method: 'POST', body: JSON.stringify({
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
      }) });
      toast(`Забронировано — заявка № ${created.orderNo} в портфеле`);
      deliveryPlanDialog(context, plan.month, flt);
    } catch (error) { toast(error.message, 'error'); }
  };
}
