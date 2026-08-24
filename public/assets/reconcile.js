// Сверка заказов 1С с рейсами планера («⚖ Сверка 1С» в блоке руководителя).
// Выгрузку «Заказы для отчёта.xlsx» руководитель подгружает вручную — она
// используется ТОЛЬКО для сравнительного анализа, 1С считается истиной.
// Методика (введена при ручной сверке августа-2026): пара ищется по машине
// и дате отправления (±1 день) в три прохода — совпавшая сумма (в т.ч. с
// точностью до НДС 22%/7%), затем совпавший заказчик, затем просто дата.
// Суммы 1С — С НДС (проверено сверкой августа: 825 пар рубль в рубль).
// reconcileOrders и parse1cRows — чистые функции, покрываются node --test.
import { api, escapeHtml, formatDateTime, money, toast } from './api.js';
import { readXlsxRows } from './xlsx-lite.js';

const MONTH_LABELS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
  'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];

// «дд.мм.гггг» (возможно с временем) → 'ГГГГ-ММ-ДД' или null.
function parseDay(value) {
  const match = String(value ?? '').trim().match(/^(\d{2})\.(\d{2})\.(\d{4})/);
  return match ? `${match[3]}-${match[2]}-${match[1]}` : null;
}

const normPlate = value => String(value ?? '').split('/')[0].trim().toLowerCase();

// Заказчик без кавычек и форм собственности — для нестрогого сопоставления.
function normCustomer(value) {
  return String(value ?? '').toLowerCase()
    .replace(/[«»"()]/g, ' ')
    .replace(/\b(ооо|оао|ао|зао|ип|тд|тк|мпк|спк)\b/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, 20);
}

// Сырые строки листа → заказы 1С. Заголовки ищутся по именам колонок,
// поэтому порядок колонок в выгрузке не важен.
export function parse1cRows(rows) {
  const headerIndex = rows.findIndex(row =>
    (row || []).some(cell => String(cell).includes('Дата отправления')) &&
    (row || []).some(cell => String(cell).includes('Сумма')));
  if (headerIndex < 0) {
    throw new Error('Не найдена строка заголовков («Дата отправления», «Сумма документа») — это выгрузка «Заказы для отчёта»?');
  }
  const header = rows[headerIndex];
  const col = name => header.findIndex(cell => String(cell ?? '').includes(name));
  const cols = {
    date: col('Дата отправления'), done: col('Дата выполнения'), plate: col('ТС'),
    driver: col('Водитель'), customer: col('Заказчик'),
    from: col('Адрес отправления'), to: col('Адрес назначения'), sum: col('Сумма')
  };
  if (cols.plate < 0 || cols.sum < 0) throw new Error('В выгрузке нет колонок «ТС» или «Сумма документа»');
  const orders = [];
  for (const row of rows.slice(headerIndex + 1)) {
    const day = parseDay(row?.[cols.date]);
    if (!day) continue;
    orders.push({
      day, doneDay: parseDay(row[cols.done]),
      plate: normPlate(row[cols.plate]),
      driver: String(row[cols.driver] ?? '').trim(),
      customer: String(row[cols.customer] ?? '').trim(),
      from: String(row[cols.from] ?? '').trim(),
      to: String(row[cols.to] ?? '').trim(),
      sum: Number(row[cols.sum]) || 0
    });
  }
  return orders;
}

// Месяцы, встречающиеся в файле (по убыванию). Выгрузка 1С накопительная
// (май–август и дальше), поэтому по умолчанию сверяется ПОСЛЕДНИЙ месяц —
// актуальный; остальные доступны выбором в диалоге.
export function fileMonths(orders) {
  const tally = {};
  for (const order of orders) {
    const key = order.day.slice(0, 7);
    tally[key] = (tally[key] || 0) + 1;
  }
  return Object.entries(tally).sort((a, b) => b[0].localeCompare(a[0]))
    .map(([month, count]) => ({ month, count }));
}

const dayDiff = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;
const near = (a, b, tolerance) => Math.abs(a - b) <= tolerance;
// Суммы равны с точностью до НДС: одна из систем хранит без НДС (22% или 7% у ИП).
const vatTwin = (planner, c1) =>
  near(planner / 1.22, c1, Math.max(2, c1 * 0.01)) ||
  near(planner / 1.07, c1, Math.max(2, c1 * 0.01)) ||
  near(planner * 1.22, c1, Math.max(2, c1 * 0.01));

// Очистка от НДС по правилам планера: ИП — 7%, остальные — 22%.
const isIp = name => /(?<![\p{L}\p{N}])ИП(?![\p{L}\p{N}])/iu.test(String(name || ''));
export const netOf = (sum, customer) => sum / (isIp(customer) ? 1.07 : 1.22);

// Главная сверка. trips — рейсы планера (bootstrap), month — 'ГГГГ-ММ'.
export function reconcileOrders(orders1c, trips, month) {
  const inMonth = orders1c.filter(order => order.day.startsWith(month));
  // Дата отправления рейса — по МСК (starts_at в базе — UTC).
  const plannerTrips = trips
    .filter(trip => trip.status !== 'rejected')
    .map(trip => ({
      ...trip,
      day: new Date(Date.parse(trip.starts_at) + 3 * 3_600_000).toISOString().slice(0, 10),
      plateKey: normPlate(trip.vehicle_plate), custKey: normCustomer(trip.customer_name)
    }))
    .filter(trip => trip.day.startsWith(month));
  for (const order of inMonth) order.custKey = normCustomer(order.customer);

  const byPlate = new Map();
  for (const trip of plannerTrips) {
    if (!byPlate.has(trip.plateKey)) byPlate.set(trip.plateKey, []);
    byPlate.get(trip.plateKey).push(trip);
  }
  const pairs = [];
  const matchPass = condition => {
    for (const order of inMonth) {
      if (order.matched) continue;
      let best = null;
      let bestDiff = null;
      for (const trip of byPlate.get(order.plate) || []) {
        if (trip.matched) continue;
        const diff = dayDiff(trip.day, order.day);
        if (diff <= 1 && condition(order, trip) && (bestDiff === null || diff < bestDiff)) {
          best = trip; bestDiff = diff;
        }
      }
      if (best) {
        order.matched = true; best.matched = true;
        pairs.push([order, best]);
      }
    }
  };
  matchPass((order, trip) => near(trip.revenue_vat, order.sum, Math.max(2, trip.revenue_vat * 0.005)));
  matchPass((order, trip) => vatTwin(trip.revenue_vat, order.sum));
  matchPass((order, trip) => order.custKey && order.custKey === trip.custKey);
  matchPass(() => true);

  const onlyC1 = inMonth.filter(order => !order.matched);
  const onlyPlanner = plannerTrips.filter(trip => !trip.matched);
  // Порог «занесено в 1С»: рейсы планера от этого дня и позже в 1С просто
  // ещё не занесены, излишками не считаются. Берётся последняя дата
  // отправления в файле, но не позже сегодняшнего дня: в выгрузке бывают
  // заказы на завтра, а рейсы сегодняшнего дня в 1С заносятся в течение дня.
  const maxDay = orders1c.reduce((max, order) => order.day > max ? order.day : max, '');
  const todayIso = new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
  const fileEdge = maxDay < todayIso ? maxDay : todayIso;
  const surplus = onlyPlanner.filter(trip => trip.day < fileEdge);
  const notYet = onlyPlanner.filter(trip => trip.day >= fileEdge);

  const exact = [];
  const vatErr = [];
  const oneRub = [];
  const other = [];
  for (const [order, trip] of pairs) {
    if (near(trip.revenue_vat, order.sum, Math.max(2, trip.revenue_vat * 0.005))) exact.push([order, trip]);
    else if (order.sum <= 10) oneRub.push([order, trip]);
    else if (vatTwin(trip.revenue_vat, order.sum)) vatErr.push([order, trip]);
    else other.push([order, trip]);
  }
  const sum = (list, pick) => list.reduce((total, item) => total + pick(item), 0);
  const c1Sum = sum(inMonth, order => order.sum);
  const notYetSum = sum(notYet, trip => trip.revenue_vat);
  return {
    month,
    monthLabel: `${MONTH_LABELS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`,
    fileEdge,
    c1: { n: inMonth.length, sum: c1Sum, net: sum(inMonth, order => netOf(order.sum, order.customer)) },
    planner: { n: plannerTrips.length, sum: sum(plannerTrips, trip => trip.revenue_vat) },
    pairs: pairs.length, exact: exact.length,
    vatErr, oneRub, other, surplus, notYet, onlyC1,
    surplusSum: sum(surplus, trip => trip.revenue_vat),
    notYetSum,
    onlyC1Sum: sum(onlyC1, order => order.sum),
    diffSum: sum([...vatErr, ...oneRub, ...other], ([order, trip]) => trip.revenue_vat - order.sum),
    trueSum: c1Sum + notYetSum
  };
}

// ── Диалог в блоке руководителя ──
const rub = value => money(Math.round(value));

function resultHtml(result) {
  const pairRow = ([order, trip], label) => `<div class="dmr-row">
    <span style="flex:1;min-width:0"><b class="mono">${escapeHtml(order.plate)}</b>
      · ${escapeHtml(order.customer || '—')}
      <small class="muted" style="display:block">${escapeHtml(order.day)} · 1С ${rub(order.sum)}
        · планер ${rub(trip.revenue_vat)}${trip.order_no ? ` · № ${escapeHtml(String(trip.order_no))}` : ''}${label ? ` · ${label}` : ''}</small></span>
    <span class="dmr-sum"><b class="${trip.revenue_vat >= order.sum ? '' : 'danger'}">${rub(trip.revenue_vat - order.sum)}</b></span>
  </div>`;
  const tripRow = trip => `<div class="dmr-row">
    <span style="flex:1;min-width:0"><b class="mono">${escapeHtml(trip.vehicle_plate)}</b>
      · ${escapeHtml(trip.customer_name || '—')}
      <small class="muted" style="display:block">${escapeHtml(trip.day)} · ${escapeHtml(trip.status)}${trip.order_no ? ` · № ${escapeHtml(String(trip.order_no))}` : ''}</small></span>
    <span class="dmr-sum"><b>${rub(trip.revenue_vat)}</b></span>
  </div>`;
  const orderRow = order => `<div class="dmr-row">
    <span style="flex:1;min-width:0"><b class="mono">${escapeHtml(order.plate)}</b>
      · ${escapeHtml(order.customer || '—')}
      <small class="muted" style="display:block">${escapeHtml(order.day)}
        · ${escapeHtml(order.from.slice(0, 24))} → ${escapeHtml(order.to.slice(0, 24))}
        · ${escapeHtml(order.driver)}</small></span>
    <span class="dmr-sum"><b>${rub(order.sum)}</b></span>
  </div>`;
  const section = (title, count, sumLabel, rows) => `<details class="rejected-details" style="margin-top:8px">
    <summary>${title} <span class="scount">${count}</span> ${sumLabel ? `· <b>${sumLabel}</b>` : ''}</summary>
    <div class="dmr-list" style="max-height:36vh;overflow:auto;margin-top:6px">${rows || '<div class="muted" style="padding:6px 0">Пусто.</div>'}</div>
  </details>`;
  return `<div id="reconcileResult">
    <h3 style="margin:12px 0 6px">Сверка за ${escapeHtml(result.monthLabel)}</h3>
    <div class="table-wrap"><table>
      <tr><td>1С: заказов за месяц (истина)</td><td><b>${result.c1.n}</b></td><td><b>${rub(result.c1.sum)}</b> с НДС · ${rub(result.c1.net)} без НДС</td></tr>
      <tr><td>Планер: рейсов с отправлением в месяце</td><td><b>${result.planner.n}</b></td><td>${rub(result.planner.sum)} с НДС</td></tr>
      <tr><td>Сопоставлено пар (суммы совпали точно)</td><td><b>${result.pairs}</b> (${result.exact})</td><td></td></tr>
      <tr><td><b>Итог: выручка месяца по 1С + ещё не занесённое</b></td><td></td><td><b>${rub(result.trueSum)}</b> с НДС</td></tr>
    </table></div>
    ${section('🔺 Излишки планера — нет в 1С (до ' + escapeHtml(result.fileEdge) + ')', result.surplus.length,
    rub(result.surplusSum), result.surplus.map(tripRow).join(''))}
    ${section('🔻 Нет в планере — только в 1С', result.onlyC1.length,
    rub(result.onlyC1Sum), result.onlyC1.map(orderRow).join(''))}
    ${section('💱 НДС-путаница (суммы расходятся ровно на НДС)', result.vatErr.length, '',
    result.vatErr.map(pair => pairRow(pair, 'НДС')).join(''))}
    ${section('❓ Прочие расхождения сумм (Δ = планер − 1С)', result.other.length,
    rub(result.diffSum) + ' суммарно', result.other.map(pair => pairRow(pair, '')).join(''))}
    ${section('🪙 Цена в 1С не проставлена (≤ 10 ₽)', result.oneRub.length, '',
    result.oneRub.map(pair => pairRow(pair, '1 ₽ в 1С')).join(''))}
    ${section('⏳ Рейсы от ' + escapeHtml(result.fileEdge) + ' — в 1С ещё не занесены (не излишек)',
    result.notYet.length, rub(result.notYetSum), result.notYet.map(tripRow).join(''))}
  </div>`;
}

export function reconcileDialog(context) {
  const { state } = context;
  const render = async () => {
    let history = [];
    try { ({ items: history } = await api('/api/reconciliation')); } catch { history = []; }
    context.showModal(`<h2>⚖ Сверка с 1С</h2>
      <p class="muted" style="margin:0 0 10px">Загрузите выгрузку 1С «Заказы для отчёта» (.xlsx) — файл
        разбирается прямо в браузере и никуда не сохраняется. 1С считается истиной: сверка покажет
        излишки планера, недостающие заказы и расхождения сумм (включая НДС-путаницу).
        Месяц сверки определяется по файлу автоматически.</p>
      <label class="field">Файл выгрузки 1С
        <input type="file" id="reconcileFile" accept=".xlsx"></label>
      <div id="reconcileBody"><p class="muted">Файл не выбран.</p></div>
      <div class="modal-actions">
        <button type="button" class="button" id="reconcileSave" style="display:none">💾 Сохранить в историю</button>
        <button type="button" class="button ghost" data-close>Закрыть</button>
      </div>
      <h3 style="margin:14px 0 6px">История сверок <span class="badge">${history.length}</span></h3>
      <div class="dmr-list" style="max-height:22vh;overflow:auto">${history.map(item => {
    const summary = JSON.parse(item.summary_json);
    return `<div class="dmr-row"><span style="flex:1;min-width:0">
        <b>${escapeHtml(summary.monthLabel || item.month)}</b> · файл «${escapeHtml(item.file_name)}»
        <small class="muted" style="display:block">${formatDateTime(item.created_at)} · ${escapeHtml(item.created_by_name || '')}
          · 1С ${summary.c1?.n ?? '—'} на ${rub(summary.c1?.sum || 0)} · излишки ${summary.surplusN ?? '—'} на ${rub(summary.surplusSum || 0)}
          · нет в планере ${summary.onlyC1N ?? '—'} на ${rub(summary.onlyC1Sum || 0)}</small></span></div>`;
  }).join('') || '<div class="muted" style="padding:6px 0">Сверок ещё не было.</div>'}</div>`, 'wide');

    let current = null;
    let currentFile = '';
    let currentOrders = null;
    const runFor = month => {
      current = reconcileOrders(currentOrders, state.data.trips, month);
      const months = fileMonths(currentOrders);
      document.getElementById('reconcileBody').innerHTML = `
        <label class="field" style="max-width:280px">Месяц сверки (в файле их несколько)
          <select id="reconcileMonth">${months.map(item =>
    `<option value="${item.month}" ${item.month === month ? 'selected' : ''}>${escapeHtml(item.month)} · заказов ${item.count}</option>`).join('')}
          </select></label>
        ${resultHtml(current)}`;
      document.getElementById('reconcileSave').style.display = '';
      document.getElementById('reconcileMonth').onchange = event => runFor(event.currentTarget.value);
    };
    document.getElementById('reconcileFile').onchange = async event => {
      const file = event.currentTarget.files?.[0];
      if (!file) return;
      const body = document.getElementById('reconcileBody');
      body.innerHTML = '<p class="muted">Разбираю файл…</p>';
      try {
        const rows = await readXlsxRows(file);
        currentOrders = parse1cRows(rows);
        if (!currentOrders.length) throw new Error('В файле не нашлось заказов с датой отправления');
        currentFile = file.name;
        // По умолчанию — последний (актуальный) месяц файла.
        runFor(fileMonths(currentOrders)[0].month);
      } catch (error) {
        current = null;
        document.getElementById('reconcileSave').style.display = 'none';
        body.innerHTML = `<p class="muted">⚠ ${escapeHtml(error.message)}</p>`;
      }
    };
    document.getElementById('reconcileSave').onclick = async () => {
      if (!current) return;
      try {
        await api('/api/reconciliation', {
          method: 'POST',
          body: JSON.stringify({
            month: current.month, fileName: currentFile,
            summary: {
              monthLabel: current.monthLabel, c1: current.c1, planner: current.planner,
              pairs: current.pairs, exact: current.exact,
              surplusN: current.surplus.length, surplusSum: current.surplusSum,
              onlyC1N: current.onlyC1.length, onlyC1Sum: current.onlyC1Sum,
              vatErrN: current.vatErr.length, otherN: current.other.length,
              diffSum: current.diffSum, notYetN: current.notYet.length,
              notYetSum: current.notYetSum, trueSum: current.trueSum
            }
          })
        });
        toast('Сверка сохранена в историю');
        render();
      } catch (error) { toast(error.message, 'error'); }
    };
  };
  render();
}
