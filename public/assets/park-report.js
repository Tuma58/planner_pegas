// «🏭 Эксплуатация парка (1С)» — отчёт по лучшей логике внешнего отчёта 1С,
// теперь формируемый прямо в планере из выгрузок Excel: Заказы (обязательно),
// Путевые листы и Ремонты (по возможности). Главное отличие от нашего
// каскада: КИП считается ПО ЧАСАМ под грузом, а не по дням, — дневной КИП
// льстил (96% против честных 57%). Потери раскладываются по причинам:
// ожидание следующего задания, ремонты по видам, «нет водителя» из планера.
import { escapeHtml, money } from './api.js';
import { excelDate, readXlsx } from './xlsx-read.js';

const H = 3_600_000;
const DAY = 86_400_000;

// Автомаппинг колонок по заголовкам: 1С меняет формулировки — ищем по
// ключевым словам, а не по позициям.
function mapColumns(rows, spec) {
  const header = rows.find(row => row && row.filter(Boolean).length >= 3) || [];
  const map = {};
  for (const [key, patterns] of Object.entries(spec)) {
    map[key] = header.findIndex(cell =>
      patterns.some(p => String(cell || '').toLowerCase().includes(p)));
  }
  return { map, headerIndex: rows.indexOf(header), header };
}

const parseDateCell = value => {
  if (!value) return null;
  const byNumber = excelDate(value);
  if (byNumber) return byNumber;
  const m = String(value).match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  const iso = String(value).match(/\d{4}-\d{2}-\d{2}/);
  return iso ? iso[0] : null;
};
const parseTimeCell = value => {
  const n = Number(value);
  if (Number.isFinite(n) && n > 0 && n < 1) return n * 24; // доля суток
  const m = String(value || '').match(/(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) + Number(m[2]) / 60 : 0;
};
const normPlate = value => String(value || '').toLowerCase().replace(/\s+/g, '');

export function parkReportDialog(context) {
  context.showModal(`<h2>🏭 Эксплуатация парка — отчёт из выгрузок 1С</h2>
    <p class="muted">Загрузите выгрузки за период (xlsx как есть, колонки распознаются по
      заголовкам). <b>Заказы</b> — обязательно; <b>Путевые листы</b> и <b>Ремонты</b> — если
      есть, каскад станет полным. «Нет водителя» и простои у клиента добавляются из планера.</p>
    <div class="form-grid" style="grid-template-columns:repeat(3,1fr)">
      <label class="field">📦 Заказы (обязательно)<input type="file" id="prOrders" accept=".xlsx"></label>
      <label class="field">📋 Путевые листы<input type="file" id="prSheets" accept=".xlsx"></label>
      <label class="field">🔧 Ремонты<input type="file" id="prRepairs" accept=".xlsx"></label>
    </div>
    <div class="modal-actions" style="justify-content:flex-start">
      <button type="button" class="button" id="prBuild">📊 Построить отчёт</button>
      <button type="button" class="button ghost" data-close>Закрыть</button>
    </div>
    <div id="prBody"><p class="muted">Формат «Заказов» — как «Заказы для отчёта» из 1С: даты
      отправления и выполнения, ТС, водитель, заказчик, адреса, сумма. Путевые листы: ТС + даты
      выезда/возвращения. Ремонты: ТС + даты начала/окончания + вид/причина.</p></div>`,
  'fullscreen');

  const body = document.getElementById('prBody');
  let parsed = null; // прочитанные файлы: период можно менять без перечтения

  const render = async period => {
    body.innerHTML = '<p class="muted">⏳ Считаю…</p>';
    try {
      body.innerHTML = await buildReport(context, parsed, period);
    } catch (error) {
      body.innerHTML = `<p class="muted">Не получилось: ${escapeHtml(error.message)}</p>`;
    }
  };

  // Панель периода: кнопки с готовым диапазоном + произвольные даты.
  body.addEventListener('click', event => {
    const btn = event.target.closest('[data-pr-from]');
    if (btn) { render({ fromIso: btn.dataset.prFrom, toIso: btn.dataset.prTo }); return; }
    if (event.target.closest('#prApply')) {
      const from = document.getElementById('prFrom')?.value;
      const to = document.getElementById('prTo')?.value;
      if (from && to && from < to) render({ fromIso: from, toIso: to });
    }
  });

  document.getElementById('prBuild').onclick = async () => {
    const fileOf = id => document.getElementById(id).files[0];
    if (!fileOf('prOrders')) { body.innerHTML = '<p class="muted">Выберите файл «Заказы».</p>'; return; }
    body.innerHTML = '<p class="muted">⏳ Читаю файлы и считаю…</p>';
    try {
      parsed = {
        orders: await readXlsx(fileOf('prOrders')),
        sheets: fileOf('prSheets') ? await readXlsx(fileOf('prSheets')) : null,
        repairs: fileOf('prRepairs') ? await readXlsx(fileOf('prRepairs')) : null
      };
      await render(null);
    } catch (error) {
      body.innerHTML = `<p class="muted">Не получилось: ${escapeHtml(error.message)}</p>`;
    }
  };
}

// export — для проверки расчёта в Node (node --test и ручные прогоны).
export async function buildReport(context, files, periodSel) {
  const data = context.state.data;
  // ── Заказы ──
  const om = mapColumns(files.orders, {
    dep: ['дата отправ'], done: ['дата выполн'],
    depTime: ['отправление с', 'время отправ'], doneTime: ['время доставки', 'доставки с'],
    plate: ['тс'], type: ['тип тс'], driver: ['водител'], customer: ['заказчик'],
    from: ['адрес отправ'], to: ['адрес назнач'], sum: ['сумма']
  });
  if (om.map.dep < 0 || om.map.plate < 0) throw new Error('В «Заказах» не найдены колонки даты отправления и ТС');
  const orders = [];
  for (const row of files.orders.slice(om.headerIndex + 1)) {
    if (!row) continue;
    const dep = parseDateCell(row[om.map.dep]);
    if (!dep) continue;
    const done = parseDateCell(row[om.map.done]) || dep;
    const depMs = Date.parse(`${dep}T00:00:00Z`) + parseTimeCell(row[om.map.depTime]) * H;
    const doneMs = Math.max(depMs + H,
      Date.parse(`${done}T00:00:00Z`) + parseTimeCell(row[om.map.doneTime]) * H);
    orders.push({ plate: normPlate(row[om.map.plate]), type: String(row[om.map.type] || '').trim(),
      driver: String(row[om.map.driver] || '').trim(), customer: String(row[om.map.customer] || '').trim(),
      from: String(row[om.map.from] || '').trim(), to: String(row[om.map.to] || '').trim(),
      depMs, doneMs, sum: Number(String(row[om.map.sum] || '0').replace(/\s/g, '').replace(',', '.')) || 0 });
  }
  if (!orders.length) throw new Error('В «Заказах» не распознано ни одной строки');
  // Excel из 1С несёт ПЛАНОВЫЕ времена. Для честного транзита сматчиваем
  // заказы с рейсами планера и берём ФАКТ: прибытие на выгрузку и фактическую
  // выгрузку — сверхнормативный простой у клиента перестаёт прятаться в
  // «плановой доставке». Матчим БЛИЖАЙШИЙ рейс машины (не первый попавшийся),
  // мультистоп 1С (несколько строк на один рейс) получает факт только
  // последней строкой — иначе часы под грузом задваиваются.
  const tsOf = value => value ? Date.parse(String(value).replace(' ', 'T') +
    (String(value).includes('Z') || String(value).includes('+') ? '' : 'Z')) : null;
  const plannerTrips = (data.trips || []).filter(trip => trip.status !== 'rejected')
    .map(trip => ({ plate: normPlate(trip.vehicle_plate), startMs: Date.parse(trip.starts_at),
      arrivedMs: tsOf(trip.arrived_at), unloadedMs: tsOf(trip.unloaded_at) }));
  const byTrip = new Map();
  for (const order of orders) {
    let match = null;
    for (const trip of plannerTrips) {
      if (trip.plate !== order.plate || Math.abs(trip.startMs - order.depMs) >= 36 * H) continue;
      if (!match || Math.abs(trip.startMs - order.depMs) < Math.abs(match.startMs - order.depMs)) match = trip;
    }
    if (!match) continue;
    const group = byTrip.get(match) || [];
    group.push(order);
    byTrip.set(match, group);
  }
  for (const [trip, group] of byTrip) {
    // Факт выгрузки — последней строке рейса (мультистоп: остальные стопы
    // остаются на плановых временах); факт дальше плана на 5+ суток — чужой
    // рейс, не обогащаем.
    const last = group.reduce((a, b) => (b.doneMs > a.doneMs ? b : a));
    if (trip.unloadedMs && trip.unloadedMs > last.depMs &&
        trip.unloadedMs < last.doneMs + 5 * DAY) {
      last.doneMs = Math.max(last.depMs + H, trip.unloadedMs);
      last.factUnload = true;
      if (trip.arrivedMs && trip.unloadedMs > trip.arrivedMs) {
        last.custWaitH = (trip.unloadedMs - trip.arrivedMs) / H;
      }
    }
  }
  // Обрезка перекрытий: обогащённая выгрузка не может заходить на погрузку
  // следующего заказа той же машины — иначе часы под грузом считаются дважды.
  const byPlateSorted = {};
  for (const order of orders) (byPlateSorted[order.plate] = byPlateSorted[order.plate] || []).push(order);
  for (const mine of Object.values(byPlateSorted)) {
    mine.sort((a, b) => a.depMs - b.depMs);
    for (let i = 1; i < mine.length; i += 1) {
      if (mine[i - 1].doneMs > mine[i].depMs) {
        mine[i - 1].doneMs = Math.max(mine[i - 1].depMs + H, mine[i].depMs);
      }
    }
  }

  // ── Период: по умолчанию месяц с наибольшим числом погрузок; кнопками —
  // другой месяц, последние 7 дней или весь файл. Часы клэмпятся к границам.
  const monthCount = {};
  for (const order of orders) {
    const key = new Date(order.depMs).toISOString().slice(0, 7);
    monthCount[key] = (monthCount[key] || 0) + 1;
  }
  const months = Object.keys(monthCount).sort();
  const monthRange = key => {
    const [y, m] = key.split('-').map(Number);
    return [Date.UTC(y, m - 1, 1), Date.UTC(y, m, 1)];
  };
  const maxDepMs = Math.max(...orders.map(o => o.depMs));
  const allRange = [Math.min(...orders.map(o => o.depMs)), maxDepMs + DAY];
  let fromMs;
  let toMs;
  if (periodSel?.fromIso) {
    fromMs = Date.parse(`${periodSel.fromIso}T00:00:00Z`);
    toMs = Date.parse(`${periodSel.toIso}T00:00:00Z`) + DAY;
  } else {
    const best = months.reduce((a, b) => (monthCount[b] > monthCount[a] ? b : a));
    [fromMs, toMs] = monthRange(best);
  }
  const inPeriod = orders.filter(o => o.depMs < toMs && o.doneMs > fromMs);
  const loaded = inPeriod.filter(o => o.depMs >= fromMs && o.depMs < toMs);
  if (!loaded.length) throw new Error('В выбранном периоде нет погрузок');
  // Часы заказа внутри периода (заказ может выходить за края).
  const clampH = o => Math.max(0, (Math.min(o.doneMs, toMs) - Math.max(o.depMs, fromMs)) / H);
  const periodDays = Math.max(1, Math.round((toMs - fromMs) / DAY));
  const dLabel = ms => new Date(ms).toLocaleDateString('ru-RU', { timeZone: 'UTC' });
  const label = `${dLabel(fromMs)} — ${dLabel(toMs - 1)}`;
  const isoOf = ms => new Date(ms).toISOString().slice(0, 10);
  const periodBar = `<div class="resctl-group" style="margin:8px 0;display:flex;gap:6px;flex-wrap:wrap;align-items:center">
      <small class="muted">Период:</small>
      ${months.slice(-3).map(key => {
        const [f, t] = monthRange(key);
        const active = f === fromMs && t === toMs;
        return `<button type="button" class="button small ${active ? '' : 'ghost'}"
          data-pr-from="${isoOf(f)}" data-pr-to="${isoOf(t - DAY)}">${new Date(f).toLocaleDateString('ru-RU', { month: 'long', year: 'numeric', timeZone: 'UTC' })} · ${monthCount[key]}</button>`;
      }).join('')}
      <button type="button" class="button small ghost" data-pr-from="${isoOf(maxDepMs - 6 * DAY)}"
        data-pr-to="${isoOf(maxDepMs)}">7 дней</button>
      <button type="button" class="button small ghost" data-pr-from="${isoOf(allRange[0])}"
        data-pr-to="${isoOf(allRange[1] - DAY)}">Весь файл</button>
      <input type="date" id="prFrom" value="${isoOf(fromMs)}" style="width:135px">
      <input type="date" id="prTo" value="${isoOf(toMs - DAY)}" style="width:135px">
      <button type="button" class="button small ghost" id="prApply">↻ Пересчитать</button>
    </div>`;

  // ── Путевые листы (линия) ──
  let sheetHours = null;
  if (files.sheets) {
    const sm = mapColumns(files.sheets, {
      plate: ['тс', 'гос'], out: ['выезд', 'выдач', 'открыт', 'дата с'],
      back: ['возвращ', 'закрыт', 'дата по']
    });
    if (sm.map.plate >= 0 && sm.map.out >= 0) {
      sheetHours = {};
      for (const row of files.sheets.slice(sm.headerIndex + 1)) {
        if (!row) continue;
        const plate = normPlate(row[sm.map.plate]);
        const out = parseDateCell(row[sm.map.out]);
        if (!plate || !out) continue;
        const back = parseDateCell(row[sm.map.back >= 0 ? sm.map.back : sm.map.out]) || out;
        // Пересечение ПЛ с выбранным периодом (даты без времени → сутки целиком).
        const overlap = Math.min(Date.parse(back) + DAY, toMs) - Math.max(Date.parse(out), fromMs);
        if (overlap <= 0) continue;
        sheetHours[plate] = (sheetHours[plate] || 0) + Math.max(4, overlap / H);
      }
    }
  }

  // ── Ремонты ──
  let repairs = null;
  const repairKinds = new Map();
  if (files.repairs) {
    const rm = mapColumns(files.repairs, {
      plate: ['тс', 'гос'], from: ['начал', 'дата с', 'открыт'], to: ['окончан', 'заверш', 'дата по', 'закрыт'],
      kind: ['вид'], cause: ['причин', 'описан', 'неисправ', 'работ']
    });
    if (rm.map.plate >= 0 && rm.map.from >= 0) {
      repairs = {};
      for (const row of files.repairs.slice(rm.headerIndex + 1)) {
        if (!row) continue;
        const plate = normPlate(row[rm.map.plate]);
        const start = parseDateCell(row[rm.map.from]);
        if (!plate || !start) continue;
        const end = parseDateCell(row[rm.map.to >= 0 ? rm.map.to : rm.map.from]) || start;
        // Пересечение ремонта с периодом; ремонт целиком вне периода не считается.
        const overlap = Math.min(Date.parse(end) + DAY / 2, toMs) - Math.max(Date.parse(start), fromMs);
        if (overlap <= 0) continue;
        const days = Math.max(0.25, overlap / DAY);
        repairs[plate] = (repairs[plate] || 0) + days;
        const kind = String(row[rm.map.kind >= 0 ? rm.map.kind : rm.map.cause] || 'не указан').trim().slice(0, 60) || 'не указан';
        const bucket = repairKinds.get(kind) || { days: 0, n: 0 };
        bucket.days += days; bucket.n += 1;
        repairKinds.set(kind, bucket);
      }
    }
  }

  // ── Каскад по часам на машину: только заказы, пересекающие период,
  // часы клэмпятся к его границам, выручка — по погрузке в периоде. ──
  const plates = [...new Set(inPeriod.map(o => o.plate))];
  const perVehicle = plates.map(plate => {
    const mine = inPeriod.filter(o => o.plate === plate).sort((a, b) => a.depMs - b.depMs);
    const loadH = mine.reduce((s, o) => s + clampH(o), 0);
    // Ожидание следующего задания: разрыв между заказами < 5 суток,
    // обрезанный границами периода.
    let waitH = 0;
    for (let i = 1; i < mine.length; i += 1) {
      const gapFrom = Math.max(mine[i - 1].doneMs, fromMs);
      const gapTo = Math.min(mine[i].depMs, toMs);
      const gap = (gapTo - gapFrom) / H;
      if (gap > 2 && gap < 120) waitH += gap;
    }
    const calH = periodDays * 24;
    const repH = Math.min(calH, (repairs?.[plate] || 0) * 24);
    const lineH = sheetHours ? Math.min(calH - repH, sheetHours[plate] || (loadH + waitH))
      : Math.min(calH - repH, loadH + waitH);
    const rev = mine.reduce((s, o) => s + (o.depMs >= fromMs && o.depMs < toMs ? o.sum : 0), 0);
    return { plate, type: mine[0].type, trips: mine.length, loadH, waitH, repH,
      lineH: Math.max(lineH, loadH), calH, rev };
  });
  const sum = key => perVehicle.reduce((s, v) => s + v[key], 0);
  const calH = sum('calH');
  const repH = sum('repH');
  const lineH = sum('lineH');
  const loadH = sum('loadH');
  const waitH = sum('waitH');
  const rev = sum('rev');
  const ktg = repairs ? (calH - repH) / calH : null;
  const kvl = lineH / (repairs ? calH - repH : calH);
  const kip = loadH / Math.max(1, lineH);
  const perLoadHour = rev / Math.max(1, loadH);
  // «Нет водителя» из планера за тот же период.
  const noDriverDays = (data.dispositions || []).filter(item => item.kind === 'no_driver' &&
    Date.parse(item.starts_at) < toMs && Date.parse(item.ends_at) > fromMs)
    .reduce((s, item) => s + (Math.min(Date.parse(item.ends_at), toMs) -
      Math.max(Date.parse(item.starts_at), fromMs)) / DAY, 0);

  // Честные сценарии: продуктивные часы × ₽/час под грузом.
  const scenario = (tKtg, tKvl, tKip) => {
    const t = calH * (tKtg ?? (repairs ? ktg : 1)) * (tKvl ?? kvl) * (tKip ?? kip);
    return t * perLoadHour;
  };
  const scenarios = [
    ['текущий каскад', scenario(null, null, null)],
    ['КИП до 70% (стыковка + локалки)', scenario(null, null, Math.max(kip, 0.7))],
    ['КВЛ до 90% (водители + выпуск)', scenario(null, Math.max(kvl, 0.9), null)],
    repairs ? ['КТГ до 95% (запчасти ≤ 1 дня)', scenario(Math.max(ktg, 0.95), null, null)] : null,
    ['целевой каскад 95 / 90 / 70',
      scenario(repairs ? Math.max(ktg, 0.95) : null, Math.max(kvl, 0.9), Math.max(kip, 0.7))]
  ].filter(Boolean);

  const worst = [...perVehicle].filter(v => v.trips >= 2)
    .sort((a, b) => (a.loadH / a.calH) - (b.loadH / b.calH)).slice(0, 10);
  const customers = {};
  for (const o of loaded) {
    const c = customers[o.customer || '—'] = customers[o.customer || '—']
      || { rev: 0, n: 0, waitH: 0, overH: 0, waited: 0, loadH: 0 };
    c.rev += o.sum; c.n += 1;
    c.loadH += (o.doneMs - o.depMs) / H;
    if (o.custWaitH != null) {
      c.waitH += o.custWaitH;
      c.overH += Math.max(0, o.custWaitH - 8); // 8 бесплатных часов норматива
      c.waited += 1;
    }
  }
  const topCustomers = Object.entries(customers).sort((a, b) => b[1].rev - a[1].rev).slice(0, 10);
  // Пожиратели времени: сверхнормативные часы у клиента × ₽/час под грузом =
  // упущенная выручка. Высокая ставка не оправдание: машина, стоящая сутки
  // на выгрузке, съедает свою же доходность.
  const timeEaters = Object.entries(customers)
    .filter(([, c]) => c.waited >= 3 && c.overH > 0)
    .map(([name, c]) => ({ name, ...c,
      avgWaitH: c.waitH / c.waited,
      lostRub: c.overH * perLoadHour,
      effHour: c.rev / Math.max(1, c.loadH) }))
    .sort((a, b) => b.lostRub - a.lostRub).slice(0, 10);
  const kindRows = [...repairKinds.entries()].sort((a, b) => b[1].days - a[1].days).slice(0, 10);

  const pct = v => `${Math.round(v * 100)}%`;
  const hrs = v => `${Math.round(v).toLocaleString('ru-RU')} ч`;
  const enrichedIn = loaded.filter(o => o.factUnload).length;
  return `${periodBar}<div class="summary-grid" style="grid-template-columns:repeat(5,1fr)">
      <div class="metric"><span>Период · машин · погрузок</span><strong>${label} · ${plates.length} · ${loaded.length}</strong></div>
      <div class="metric"><span>Выручка (погрузка в периоде)</span><strong>${money(Math.round(rev))}
        <small class="muted" style="display:block">факт выгрузки из планера: ${enrichedIn} из ${loaded.length}</small></strong></div>
      <div class="metric"><span>КТГ (ремонты)</span><strong>${repairs ? pct(ktg) : '— загрузите «Ремонты»'}</strong></div>
      <div class="metric"><span>КВЛ (на линии)</span><strong>${pct(kvl)}${sheetHours ? '' : ' *'}</strong></div>
      <div class="metric"><span>КИП по часам под грузом</span><strong>${pct(kip)}</strong></div>
    </div>
    ${sheetHours ? '' : '<p class="muted">* без «Путевых листов» линия оценена как «груз + ожидание между заказами» — КВЛ ориентировочный.</p>'}
    <div class="salesboard"><div class="scol">
      <div class="scolh">Куда уходят часы линии</div>
      <div class="list">
        <div class="list-item"><span style="flex:1">📦 Под грузом</span><b>${hrs(loadH)} · ${pct(kip)}</b></div>
        <div class="list-item"><span style="flex:1">⏳ Ожидание следующего задания <small class="muted">— главная потеря и в 1С, и в планере (наша метрика «зазор стыковки»)</small></span><b>${hrs(waitH)} ≈ ${Math.round(waitH / 24)} маш-дн</b></div>
        <div class="list-item"><span style="flex:1">👤 Нет водителя <small class="muted">(из планера)</small></span><b>${Math.round(noDriverDays)} маш-дн</b></div>
        ${repairs ? `<div class="list-item"><span style="flex:1">🔧 Ремонты</span><b>${hrs(repH)} ≈ ${Math.round(repH / 24)} маш-дн</b></div>` : ''}
      </div>
      ${kindRows.length ? `<div class="scolh" style="margin-top:10px">Ремонты по видам (дни · случаи)</div>
      <div class="list">${kindRows.map(([kind, b]) => `<div class="list-item">
        <span style="flex:1">${escapeHtml(kind)}</span><b>${Math.round(b.days)} дн · ${b.n}</b></div>`).join('')}</div>` : ''}
      <div class="scolh" style="margin-top:10px">Сценарии (честные: часы × ₽/час под грузом ${money(Math.round(perLoadHour))})</div>
      <div class="list">${scenarios.map(([name, value]) => `<div class="list-item">
        <span style="flex:1">${escapeHtml(name)}</span><b>${money(Math.round(value))}</b></div>`).join('')}</div>
    </div>
    <div class="scol">
      <div class="scolh">Худшие по доле часов под грузом</div>
      <div class="list">${worst.map(v => `<div class="list-item">
        <span style="flex:1"><b class="mono">${escapeHtml(v.plate)}</b>
          <small class="muted"> · ${escapeHtml(v.type)} · рейсов ${v.trips}</small></span>
        <b>${pct(v.loadH / v.calH)} · ${money(Math.round(v.rev))}</b></div>`).join('')}</div>
      ${timeEaters.length ? `<div class="scolh" style="margin-top:10px">⏱ Где теряем время у клиентов
        <small class="muted" style="font-weight:400"> · сверх 8 бесплатных часов на выгрузке, по ФАКТУ планера</small></div>
      <div class="list">${timeEaters.map(c => `<div class="list-item ${c.effHour < perLoadHour ? 'q-late-row' : ''}">
        <span style="flex:1;min-width:0">${escapeHtml(c.name.slice(0, 34))}
          <small class="muted" style="display:block">выгрузка в среднем ${c.avgWaitH.toFixed(1)} ч
            · сверхнорматив ${Math.round(c.overH)} ч на ${c.waited} рейсах
            · эффективная ставка ${money(Math.round(c.effHour))}/ч ${c.effHour < perLoadHour ? '⚠ ниже средней' : ''}</small></span>
        <b title="Сверхнормативные часы × средняя выручка часа под грузом">−${money(Math.round(c.lostRub))}</b>
      </div>`).join('')}</div>
      <p class="muted">Даже при высокой ставке перевозки клиент с суточной выгрузкой
        съедает доходность машины: сравнивайте эффективную ₽/час, а не ставку рейса.
        Сверхнорматив — основание для претензии (⏳ Простои П/В).</p>` : ''}
      <div class="scolh" style="margin-top:10px">Клиенты периода</div>
      <div class="list">${topCustomers.map(([name, c]) => `<div class="list-item">
        <span style="flex:1">${escapeHtml(name.slice(0, 40))}<small class="muted"> · ${c.n}</small></span>
        <b>${money(Math.round(c.rev))}</b></div>`).join('')}</div>
    </div></div>`;
}
