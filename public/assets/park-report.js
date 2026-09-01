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

  document.getElementById('prBuild').onclick = async () => {
    const body = document.getElementById('prBody');
    const fileOf = id => document.getElementById(id).files[0];
    if (!fileOf('prOrders')) { body.innerHTML = '<p class="muted">Выберите файл «Заказы».</p>'; return; }
    body.innerHTML = '<p class="muted">⏳ Читаю файлы и считаю…</p>';
    try {
      body.innerHTML = await buildReport(context, {
        orders: await readXlsx(fileOf('prOrders')),
        sheets: fileOf('prSheets') ? await readXlsx(fileOf('prSheets')) : null,
        repairs: fileOf('prRepairs') ? await readXlsx(fileOf('prRepairs')) : null
      });
    } catch (error) {
      body.innerHTML = `<p class="muted">Не получилось: ${escapeHtml(error.message)}</p>`;
    }
  };
}

async function buildReport(context, files) {
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
  const fromMs = Math.min(...orders.map(o => o.depMs));
  const toMs = Math.max(...orders.map(o => o.doneMs));
  const periodDays = Math.max(1, Math.round((toMs - fromMs) / DAY));
  const label = `${new Date(fromMs).toLocaleDateString('ru-RU')} — ${new Date(toMs).toLocaleDateString('ru-RU')}`;

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
        const hours = Math.max(4, (Date.parse(back) - Date.parse(out)) / H + 24);
        sheetHours[plate] = (sheetHours[plate] || 0) + hours;
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
        const days = Math.max(0.25, (Date.parse(end) - Date.parse(start)) / DAY + 0.5);
        repairs[plate] = (repairs[plate] || 0) + days;
        const kind = String(row[rm.map.kind >= 0 ? rm.map.kind : rm.map.cause] || 'не указан').trim().slice(0, 60) || 'не указан';
        const bucket = repairKinds.get(kind) || { days: 0, n: 0 };
        bucket.days += days; bucket.n += 1;
        repairKinds.set(kind, bucket);
      }
    }
  }

  // ── Каскад по часам на машину ──
  const plates = [...new Set(orders.map(o => o.plate))];
  const perVehicle = plates.map(plate => {
    const mine = orders.filter(o => o.plate === plate).sort((a, b) => a.depMs - b.depMs);
    const loadH = mine.reduce((s, o) => s + (o.doneMs - o.depMs) / H, 0);
    // Ожидание следующего задания: разрыв между заказами < 5 суток.
    let waitH = 0;
    for (let i = 1; i < mine.length; i += 1) {
      const gap = (mine[i].depMs - mine[i - 1].doneMs) / H;
      if (gap > 2 && gap < 120) waitH += gap;
    }
    const calH = periodDays * 24;
    const repH = (repairs?.[plate] || 0) * 24;
    const lineH = sheetHours ? Math.min(calH - repH, sheetHours[plate] || (loadH + waitH))
      : loadH + waitH;
    const rev = mine.reduce((s, o) => s + o.sum, 0);
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
  for (const o of orders) {
    const c = customers[o.customer || '—'] = customers[o.customer || '—'] || { rev: 0, n: 0 };
    c.rev += o.sum; c.n += 1;
  }
  const topCustomers = Object.entries(customers).sort((a, b) => b[1].rev - a[1].rev).slice(0, 10);
  const kindRows = [...repairKinds.entries()].sort((a, b) => b[1].days - a[1].days).slice(0, 10);

  const pct = v => `${Math.round(v * 100)}%`;
  const hrs = v => `${Math.round(v).toLocaleString('ru-RU')} ч`;
  return `<div class="summary-grid" style="grid-template-columns:repeat(5,1fr)">
      <div class="metric"><span>Период · машин · заказов</span><strong>${label} · ${plates.length} · ${orders.length}</strong></div>
      <div class="metric"><span>Выручка (сумма документов)</span><strong>${money(Math.round(rev))}</strong></div>
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
      <div class="scolh" style="margin-top:10px">Клиенты периода</div>
      <div class="list">${topCustomers.map(([name, c]) => `<div class="list-item">
        <span style="flex:1">${escapeHtml(name.slice(0, 40))}<small class="muted"> · ${c.n}</small></span>
        <b>${money(Math.round(c.rev))}</b></div>`).join('')}</div>
    </div></div>`;
}
