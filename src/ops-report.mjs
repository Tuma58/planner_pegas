// Отчёт эксплуатации руководителя (заказ 21.09.2026): за произвольный
// период, показатели КОЛИЧЕСТВЕННО в машинах рядом с процентами, простой
// по причинам, опоздания на погрузку/выгрузку, живые графики.
// Один источник цифр: канон parkReportData передаётся из server.mjs
// (без дублирования), сюда добавляются ряды по дням и разборы.
// Потребители: страница /ops-report, JSON /api/ops-report, ежедневная
// сводка в Telegram и ленту руководителя.

const NET = `CASE WHEN t.cash THEN t.revenue_vat
  WHEN t.customer_name LIKE '%ИП%' THEN t.revenue_vat/1.07 ELSE t.revenue_vat/1.22 END`;

const dayList = (from, to) => {
  const out = [];
  for (let ms = Date.parse(`${from}T00:00:00Z`); ms < Date.parse(`${to}T00:00:00Z`); ms += 86_400_000) {
    out.push(new Date(ms).toISOString().slice(0, 10));
  }
  return out;
};

export function opsReportData(db, from, to, parkFn) {
  // Будущие дни — не машино-дни: период обрезается по «завтра» (сегодня
  // входит целиком), иначе нулевой хвост будущего занижает линию и
  // раздувает «без причины». Полностью будущий период не трогаем.
  const cap = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  if (to > cap && cap > from) to = cap;
  const park = parkFn(from, to);
  const days = dayList(from, to);
  const T = park.total;

  // Ряды по дням: выручка без НДС и рейсы (по выгрузкам).
  const byDay = new Map(db.prepare(`SELECT substr(COALESCE(t.unloaded_at,t.ends_at),1,10) d,
      COUNT(*) n, SUM(${NET}) net FROM trips t WHERE t.status<>'rejected'
      AND substr(COALESCE(t.unloaded_at,t.ends_at),1,10) >= ?
      AND substr(COALESCE(t.unloaded_at,t.ends_at),1,10) < ?
      GROUP BY d`).all(from, to).map(r => [r.d, r]));
  const revDays = days.map(d => +((byDay.get(d)?.net || 0) / 1e6).toFixed(2));
  const tripDays = days.map(d => byDay.get(d)?.n || 0);

  // Машины на линии по дням (канон: «на линию»→выгрузка + перегоны).
  const spans = [];
  for (const t of db.prepare(`SELECT vehicle_id,status,starts_at,ends_at,on_line_at,unloaded_at
      FROM trips WHERE status<>'rejected' AND starts_at < ? AND COALESCE(unloaded_at,ends_at) > ?`)
    .all(to, from)) {
    const a = Date.parse(t.on_line_at || t.starts_at);
    const b = t.unloaded_at ? Date.parse(t.unloaded_at)
      : ['plan', 'run'].includes(t.status) ? Math.max(Date.parse(t.ends_at), Date.now()) : Date.parse(t.ends_at);
    if (b > a) spans.push({ v: t.vehicle_id, a, b });
  }
  for (const d of db.prepare(`SELECT vehicle_id,starts_at,ends_at FROM vehicle_dispositions
      WHERE kind='transfer' AND starts_at < ? AND ends_at > ?`).all(to, from)) {
    spans.push({ v: d.vehicle_id, a: Date.parse(d.starts_at), b: Date.parse(d.ends_at) });
  }
  const online = days.map(d => {
    const d0 = Date.parse(`${d}T00:00:00Z`);
    return new Set(spans.filter(s => s.a < d0 + 86_400_000 && s.b > d0).map(s => s.v)).size;
  });

  // Простой по причинам, машино-часы за период → среднесуточно машин.
  const clamp = `SUM((julianday(MIN(ends_at, :b)) - julianday(MAX(starts_at, :a))) * 24)`;
  const kinds = { repair: 'ремонт', shift: 'пересменка', no_driver: 'без водителя',
    reserve: 'резерв', out: 'выведена' };
  const downtime = {};
  for (const [kind, label] of Object.entries(kinds)) {
    const h = db.prepare(`SELECT COALESCE(${clamp},0) h FROM vehicle_dispositions
        WHERE kind=? AND starts_at < :b AND ends_at > :a`)
      .get({ a: from, b: to }, kind).h;
    downtime[kind] = { label, hours: Math.round(h), avg: +(h / 24 / T.days).toFixed(1) };
  }
  // «Без причины» считаем от ЖИВОЙ линии (ряд online включает идущие
  // рейсы) — канонная lineH знает только закрытые и на свежем хвосте
  // периода занижает линию, раздувая «без причины» в разы.
  const avgOnline = +(online.reduce((s, v) => s + v, 0) / Math.max(1, online.length)).toFixed(1);
  const explainedAvg = Object.values(downtime).reduce((s, x) => s + x.avg, 0);
  const noReasonAvg = Math.max(0, +(T.fleet - avgOnline - explainedAvg).toFixed(1));
  downtime.no_reason = { label: 'без причины (ждёт заказ)',
    hours: Math.round(noReasonAvg * 24 * T.days), avg: noReasonAvg };

  // Кто в простое прямо сейчас — поимённо, с причиной.
  const zones = new Map(db.prepare('SELECT id, name FROM zones').all().map(z => [z.id, z.name]));
  const nowMs = Date.now();
  const idleNow = [];
  for (const v of db.prepare(`SELECT id, plate, driver_name FROM vehicles WHERE status='work'`).all()) {
    const busy = spans.some(s => s.v === v.id && s.a < nowMs && s.b > nowMs) ||
      db.prepare(`SELECT 1 FROM trips WHERE vehicle_id=? AND status IN ('plan','run')
          AND starts_at < ? LIMIT 1`).get(v.id, new Date(nowMs + 12 * 3.6e6).toISOString());
    if (busy) continue;
    const disp = db.prepare(`SELECT kind, note, ends_at FROM vehicle_dispositions
        WHERE vehicle_id=? AND starts_at < ? AND ends_at > ?
        ORDER BY starts_at LIMIT 1`)
      .get(v.id, new Date(nowMs).toISOString(), new Date(nowMs).toISOString());
    const last = db.prepare(`SELECT unloaded_at, to_zone_id FROM trips
        WHERE vehicle_id=? AND unloaded_at IS NOT NULL ORDER BY unloaded_at DESC LIMIT 1`).get(v.id);
    idleNow.push({ plate: v.plate, driver: (v.driver_name || 'без водителя').split(' ')[0],
      reason: disp ? (kinds[disp.kind] || disp.kind) : 'без причины',
      since: last ? String(last.unloaded_at).slice(5, 10) : '—',
      where: last ? (zones.get(last.to_zone_id) || '?') : '?' });
  }
  idleNow.sort((a, b) => (a.reason === 'без причины' ? 0 : 1) - (b.reason === 'без причины' ? 0 : 1) ||
    a.since.localeCompare(b.since));

  // Опоздания прибытий по точкам рейса (план/факт), >1 ч — опоздание.
  const late = { P: null, D: null };
  for (const kind of ['P', 'D']) {
    const rows = db.prepare(`SELECT s.planned_arrival p, s.actual_arrival f, t.customer_name c,
        substr(COALESCE(t.unloaded_at,t.ends_at),1,10) day
      FROM trip_stops s JOIN trips t ON t.id=s.trip_id
      WHERE s.kind=? AND t.status<>'rejected'
        AND s.planned_arrival IS NOT NULL AND s.actual_arrival IS NOT NULL
        AND substr(COALESCE(t.unloaded_at,t.ends_at),1,10) >= ?
        AND substr(COALESCE(t.unloaded_at,t.ends_at),1,10) < ?`).all(kind, from, to);
    const c = { n: rows.length, late1: 0, late3: 0, median: 0, byDayPct: [], top: [] };
    const perDay = new Map(days.map(d => [d, { n: 0, late: 0 }]));
    const byCust = new Map();
    const delays = [];
    for (const r of rows) {
      const dh = (Date.parse(r.f) - Date.parse(r.p)) / 3.6e6;
      const slot = perDay.get(r.day);
      if (slot) slot.n += 1;
      if (dh > 1) {
        c.late1 += 1;
        delays.push(dh);
        if (slot) slot.late += 1;
        const k = (r.c || '—').trim();
        if (!byCust.has(k)) byCust.set(k, { n: 0, sum: 0 });
        byCust.get(k).n += 1;
        byCust.get(k).sum += dh;
      }
      if (dh > 3) c.late3 += 1;
    }
    delays.sort((x, y) => x - y);
    c.median = delays.length ? +delays[delays.length >> 1].toFixed(1) : 0;
    c.byDayPct = days.map(d => {
      const s = perDay.get(d);
      return s && s.n ? +(s.late / s.n * 100).toFixed(1) : 0;
    });
    c.top = [...byCust.entries()].sort((x, y) => y[1].n - x[1].n).slice(0, 7)
      .map(([name, v]) => ({ name, n: v.n, avgH: +(v.sum / v.n).toFixed(1) }));
    late[kind] = c;
  }

  // Динамика КТГ/КВЛ/КИП и выручки: по дням и понедельно (пн–вс).
  // Методика та же, что в плитках: техготовность и «выведена» — из
  // диспозиций, линия — живой ряд, КИП — по закрытым рейсам.
  const dayMs = days.map(d => Date.parse(`${d}T00:00:00Z`));
  const perDayHours = rows => {
    const out = days.map(() => 0);
    for (const r of rows) {
      const a = Date.parse(String(r.starts_at).replace(' ', 'T'));
      const b = Date.parse(String(r.ends_at).replace(' ', 'T'));
      days.forEach((d, i) => {
        out[i] += Math.max(0, Math.min(b, dayMs[i] + 86_400_000) - Math.max(a, dayMs[i])) / 3.6e6;
      });
    }
    return out;
  };
  const remDayH = perDayHours(db.prepare(`SELECT starts_at,ends_at FROM vehicle_dispositions
      WHERE kind='repair' AND starts_at < ? AND ends_at > ?`).all(to, from));
  const outDayH = perDayHours(db.prepare(`SELECT starts_at,ends_at FROM vehicle_dispositions
      WHERE kind='out' AND starts_at < ? AND ends_at > ?`).all(to, from));
  const techDay = days.map((d, i) => Math.max(0, T.fleet - remDayH[i] / 24 - outDayH[i] / 24));
  const lineDayH = days.map(() => 0), prodDayH = days.map(() => 0);
  for (const t of db.prepare(`SELECT t.on_line_at,t.starts_at,t.ends_at,t.unloaded_at,t.arrived_at,
      (SELECT MIN(s.actual_departure) FROM trip_stops s WHERE s.trip_id=t.id AND s.kind='P'
        AND s.actual_departure IS NOT NULL) dep
      FROM trips t WHERE t.status IN ('unloaded','done','paid','run')
        AND t.starts_at < ? AND COALESCE(t.unloaded_at,t.ends_at) > ?`).all(to, from)) {
    const on = Date.parse(String(t.on_line_at || t.starts_at).replace(' ', 'T'));
    const fin = Date.parse(String(t.unloaded_at || t.ends_at).replace(' ', 'T'));
    const dp = t.dep ? Date.parse(String(t.dep).replace(' ', 'T')) : null;
    const de = t.arrived_at ? Date.parse(String(t.arrived_at).replace(' ', 'T')) : fin;
    days.forEach((d, i) => {
      const a0 = dayMs[i], b0 = a0 + 86_400_000;
      lineDayH[i] += Math.max(0, Math.min(fin, b0) - Math.max(on, a0)) / 3.6e6;
      if (dp) prodDayH[i] += Math.max(0, Math.min(de, b0) - Math.max(dp, a0)) / 3.6e6;
    });
  }
  const pct1 = v => +Math.min(100, Math.max(0, v * 100)).toFixed(1);
  const trendDay = {
    labels: days.map(d => d.slice(8)),
    tips: days.map(d => `${d.slice(8)}.${d.slice(5, 7)}`),
    rev: revDays,
    ktg: techDay.map(v => pct1(v / Math.max(1, T.fleet))),
    kvl: techDay.map((v, i) => pct1(online[i] / Math.max(0.001, v))),
    kip: days.map((d, i) => lineDayH[i] > 0.5 ? pct1(prodDayH[i] / lineDayH[i]) : 0)
  };
  const wkKey = d => {
    const t = Date.parse(`${d}T00:00:00Z`);
    return new Date(t - ((new Date(t).getUTCDay() + 6) % 7) * 86_400_000).toISOString().slice(0, 10);
  };
  const wOrder = [], wMap = new Map();
  days.forEach((d, i) => {
    const k = wkKey(d);
    if (!wMap.has(k)) { wMap.set(k, []); wOrder.push(k); }
    wMap.get(k).push(i);
  });
  const avg = arr => arr.reduce((s, v) => s + v, 0) / Math.max(1, arr.length);
  const trendWeek = { labels: [], tips: [], rev: [], ktg: [], kvl: [], kip: [] };
  for (const k of wOrder) {
    const idx = wMap.get(k);
    const d1 = days[idx[0]], d2 = days[idx[idx.length - 1]];
    trendWeek.labels.push(`${d1.slice(8)}–${d2.slice(8)}`);
    trendWeek.tips.push(`${d1.slice(8)}.${d1.slice(5, 7)}–${d2.slice(8)}.${d2.slice(5, 7)}`);
    trendWeek.rev.push(+idx.reduce((s, i) => s + revDays[i], 0).toFixed(2));
    const tech = avg(idx.map(i => techDay[i]));
    trendWeek.ktg.push(pct1(tech / Math.max(1, T.fleet)));
    trendWeek.kvl.push(pct1(avg(idx.map(i => online[i])) / Math.max(0.001, tech)));
    const lh = idx.reduce((s, i) => s + lineDayH[i], 0);
    trendWeek.kip.push(lh > 0.5 ? pct1(idx.reduce((s, i) => s + prodDayH[i], 0) / lh) : 0);
  }
  const trend = { day: trendDay, week: trendWeek };

  return { from, to, days, park, revDays, tripDays, online, avgOnline, downtime, idleNow, late, trend };
}

// Текстовая ежедневная сводка (Telegram и лента руководителя): вчера +
// месяц к дате, показатели в машинах, простой по причинам, опоздания.
export function dailyOpsText(db, parkFn) {
  const today = new Date().toISOString().slice(0, 10);
  const y = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const monthFrom = `${today.slice(0, 7)}-01`;
  const day = opsReportData(db, y, today, parkFn);
  const month = monthFrom < today ? opsReportData(db, monthFrom, today, parkFn) : day;
  const T = day.park.total;
  const M = month.park.total;
  const idleBad = day.idleNow.filter(x => x.reason === 'без причины');
  const fmtM = v => (v / 1e6).toFixed(1);
  const lines = [
    `📊 Эксплуатация за ${y.slice(8, 10)}.${y.slice(5, 7)} (планер)`,
    `Выручка без НДС: ${fmtM(T.rev)} млн · рейсов ${T.trips} · месяц к дате: ${fmtM(M.rev)} млн`,
    (() => {
      const ktgCars = T.fleet - day.downtime.repair.avg;
      const kvlDay = ktgCars ? Math.round(day.avgOnline / ktgCars * 100) : 0;
      return `Парк ${T.fleet}: техготовность ${ktgCars.toFixed(0)} маш (КТГ ${Math.round(ktgCars / T.fleet * 100)}%) · на линии ${day.avgOnline} маш (КВЛ ${kvlDay}%) · под грузом ~${(day.avgOnline * M.kip / 100).toFixed(0)} маш (КИП мес ${M.kip}%)`;
    })(),
    `Простой: ремонт ${day.downtime.repair.avg} · без водителя ${day.downtime.no_driver.avg} · пересменка ${day.downtime.shift.avg} · без причины ${day.downtime.no_reason.avg} маш/сут`,
    `Опоздания >1ч: погрузка ${day.late.P.late1}/${day.late.P.n} · выгрузка ${day.late.D.late1}/${day.late.D.n}` +
      (day.late.D.top[0] ? ` · чаще всех ждал: ${day.late.D.top[0].name}` : ''),
    idleBad.length
      ? `⚠ Сейчас без заказа и причины: ${idleBad.slice(0, 6).map(x => `${x.plate} (${x.where}, с ${x.since})`).join(', ')}${idleBad.length > 6 ? ` и ещё ${idleBad.length - 6}` : ''}`
      : '✅ Машин без заказа и причины сейчас нет',
    `Полный отчёт с графиками: /ops-report (период задаётся датами)`
  ];
  return lines.join('\n');
}

const esc = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

// HTML-страница отчёта: самодостаточная, графики SVG с подсказками,
// светлая/тёмная тема, печать в PDF браузером.
export function renderOpsReportHtml(data, theme = '') {
  const { park, days, revDays, tripDays, online, downtime, idleNow, late, trend } = data;
  const T = park.total;
  const D = trend.day, WK = trend.week;
  const cars = h => (h / 24 / T.days).toFixed(1);
  const W = 980, H = 190, PL = 44, PR = 10, PT = 12, PB = 26;
  const plotH = H - PT - PB;

  const grid = mx => {
    let s = '';
    for (let g = 1; g <= 4; g += 1) {
      const yy = H - PB - plotH * g / 4;
      s += `<line class="gridline" x1="${PL}" y1="${yy.toFixed(0)}" x2="${W - PR}" y2="${yy.toFixed(0)}"/>` +
        `<text x="${PL - 6}" y="${(yy + 4).toFixed(0)}" text-anchor="end">${+(mx * g / 4).toFixed(1)}</text>`;
    }
    return s;
  };
  const xLabels = (axis, step) => {
    let s = '';
    const dx = (W - PL - PR) / Math.max(1, axis.length - 1);
    for (let i = 0; i < axis.length; i += step) {
      // Длинную подпись у правого края прижимаем, чтобы не резалась.
      const x = Math.min(PL + i * dx, axis[i].length > 3 ? W - 4 * axis[i].length : W - PR);
      s += `<text x="${x.toFixed(0)}" y="${H - PB + 14}" text-anchor="middle">${axis[i]}</text>`;
    }
    return s;
  };
  // Подпись значения (заказ 22.09 «показатели в цифрах на графиках»):
  // короткий формат, чтобы влезало над узким столбцом/точкой.
  const fmtVal = v => Math.abs(v) >= 20 ? String(Math.round(v)) : String(+(+v).toFixed(1));
  const barsSvg = (vals, axis, tips, color, unit, step = 2) => {
    const mx = Math.max(...vals, 0.001) * 1.18;
    const bw = (W - PL - PR) / vals.length;
    let s = grid(mx);
    vals.forEach((v, i) => {
      const h = plotH * v / mx;
      s += `<rect x="${(PL + i * bw + 1).toFixed(1)}" y="${(H - PB - h).toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${h.toFixed(1)}" rx="4" fill="${color}" data-tip="${tips[i]}: ${v}${unit}"/>` +
        `<text x="${(PL + i * bw + bw / 2).toFixed(0)}" y="${(H - PB - h - 4).toFixed(0)}" text-anchor="middle" class="val" font-size="9.5">${fmtVal(v)}</text>`;
      if (i % step === 0) s += `<text x="${(PL + i * bw + bw / 2).toFixed(0)}" y="${H - PB + 14}" text-anchor="middle">${axis[i]}</text>`;
    });
    return `<svg viewBox="0 0 ${W} ${H}" width="100%">${s}</svg>`;
  };
  const linesSvg = (series, names, axis, tips, colors, unit, ymax, step = 2) => {
    const mx = ymax || Math.max(...series.flat(), 1) * 1.15;
    const n = series[0].length;
    const dx = (W - PL - PR) / Math.max(1, n - 1);
    // Подписи значений: на каждой точке, пока просторно, иначе с шагом
    // оси; чётные серии подписываются над точкой, нечётные — под, чтобы
    // близкие линии не слепляли цифры.
    const labelStep = n > 16 ? step : 1;
    let s = grid(mx);
    series.forEach((vals, si) => {
      const pts = vals.map((v, i) => `${(PL + i * dx).toFixed(1)},${(H - PB - plotH * v / mx).toFixed(1)}`).join(' ');
      s += `<polyline points="${pts}" fill="none" stroke="${colors[si]}" stroke-width="2"/>`;
      vals.forEach((v, i) => {
        const cx = (PL + i * dx).toFixed(1);
        const cy = (H - PB - plotH * v / mx).toFixed(1);
        s += `<circle cx="${cx}" cy="${cy}" r="8" fill="transparent" data-tip="${tips[i]} · ${names[si]}: ${v}${unit}"/>` +
          `<circle cx="${cx}" cy="${cy}" r="3" fill="${colors[si]}" stroke="var(--surface-1)" stroke-width="2" pointer-events="none"/>`;
        if (i % labelStep === 0) {
          s += `<text x="${cx}" y="${(Number(cy) + (si % 2 ? 16 : -7)).toFixed(0)}" text-anchor="middle" class="val" font-size="9.5" pointer-events="none">${fmtVal(v)}</text>`;
        }
      });
    });
    return `<svg viewBox="0 0 ${W} ${H}" width="100%">${s + xLabels(axis, step)}</svg>`;
  };
  // Переключатель «По дням | По неделям»: оба SVG отрисованы сервером,
  // клиентский скрипт лишь меняет видимость (CSP: инлайн-JS запрещён).
  const granPair = (key, daySvg, weekSvg) =>
    `<div class="chart" data-chart="${key}" data-mode="day">${daySvg}</div>` +
    `<div class="chart" data-chart="${key}" data-mode="week" hidden>${weekSvg}</div>`;
  const granSeg = key => `<span class="seg" data-tgl="${key}">` +
    `<button type="button" class="on" data-mode="day">По дням</button>` +
    `<button type="button" data-mode="week">По неделям</button></span>`;
  const hbars = (items, color) => {
    if (!items.length) return '<p class="note">опозданий не зафиксировано</p>';
    const rh = 26;
    const mx = Math.max(...items.map(x => x.n)) * 1.25;
    let s = '';
    items.forEach((it, i) => {
      const w = (W - 300) * it.n / mx;
      const y = i * rh + 4;
      s += `<text x="216" y="${y + 15}" text-anchor="end" class="val">${esc(it.name).slice(0, 34)}</text>` +
        `<rect x="224" y="${y + 3}" width="${Math.max(w, 3).toFixed(0)}" height="16" rx="4" fill="${color}" data-tip="${esc(it.name)}: ${it.n} опозданий, в среднем +${it.avgH} ч"/>` +
        `<text x="${(228 + Math.max(w, 3)).toFixed(0)}" y="${y + 15}">${it.n} · +${it.avgH} ч</text>`;
    });
    return `<svg viewBox="0 0 ${W} ${items.length * rh + 8}" width="100%">${s}</svg>`;
  };
  const onP = late.P.n ? Math.round((late.P.n - late.P.late1) / late.P.n * 100) : 100;
  const onD = late.D.n ? Math.round((late.D.n - late.D.late1) / late.D.n * 100) : 100;
  const dtRow = Object.values(downtime).map(x =>
    `<div class="tile"><span>${x.label}</span><b>${x.avg} маш</b><small>${x.hours} маш-ч за период</small></div>`).join('');
  const idleRows = idleNow.map(x =>
    `<tr><td>${esc(x.plate)}</td><td>${esc(x.driver)}</td><td>${esc(x.reason)}</td><td>${esc(x.where)}</td><td>${x.since}</td></tr>`).join('');
  const weeksRows = park.weeks.map(w =>
    `<tr><td>${w.from.slice(8)}–${w.to.slice(8)}.${w.to.slice(5, 7)}</td><td>${(w.rev / 1e6).toFixed(1)}</td><td>${w.trips}</td><td>${w.ktg}</td><td>${w.kvl}</td><td>${w.kip}</td></tr>`).join('');
  const clientRows = park.clients.map(c =>
    `<tr><td>${esc(c.name)}</td><td>${c.n}</td><td>${(c.rev / 1e6).toFixed(1)}</td></tr>`).join('');

  return `<!DOCTYPE html><html lang="ru"${theme ? ` data-theme="${theme}"` : ''}><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Отчёт эксплуатации · планер · ${data.from} — ${data.to}</title>
<style>
.viz-root{color-scheme:light;
 --surface-1:#fcfcfb;--surface-2:#f2f1ee;--text-primary:#0b0b0b;--text-secondary:#52514e;--muted:#8a887f;
 --line:#e3e1da;--s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a;--bad:#b8352a}
@media (prefers-color-scheme: dark){:root:where(:not([data-theme="light"])) .viz-root{color-scheme:dark;
 --surface-1:#1a1a19;--surface-2:#242422;--text-primary:#fff;--text-secondary:#c3c2b7;--muted:#8f8d83;
 --line:#393833;--s1:#3987e5;--s2:#d95926;--s3:#199e70;--bad:#ef8377}}
:root[data-theme="dark"] .viz-root{color-scheme:dark;
 --surface-1:#1a1a19;--surface-2:#242422;--text-primary:#fff;--text-secondary:#c3c2b7;--muted:#8f8d83;
 --line:#393833;--s1:#3987e5;--s2:#d95926;--s3:#199e70;--bad:#ef8377}
body{margin:0;background:#fcfcfb}
@media (prefers-color-scheme: dark){:root:where(:not([data-theme="light"])) body{background:#1a1a19}}
:root[data-theme="dark"] body{background:#1a1a19}
:root[data-theme="light"] body{background:#fcfcfb}
.viz-root{font:14px/1.45 "Segoe UI",Roboto,Arial,sans-serif;color:var(--text-primary);
 background:var(--surface-1);max-width:1080px;margin:0 auto;padding:24px 30px 50px}
h1{font-size:20px;margin:0 0 2px}
.sub{color:var(--text-secondary);font-size:12.5px;margin-bottom:14px}
.pick{display:flex;gap:8px;align-items:center;font-size:13px;margin-bottom:14px}
.pick input{font:inherit;padding:3px 6px;border:1px solid var(--line);border-radius:4px;
 background:var(--surface-1);color:var(--text-primary)}
.pick button{font:inherit;padding:4px 12px;border:1px solid var(--line);border-radius:4px;
 background:var(--surface-2);color:var(--text-primary);cursor:pointer}
h2{font-size:15px;margin:26px 0 8px;border-bottom:1px solid var(--line);padding-bottom:5px}
.tiles{display:flex;flex-wrap:wrap;gap:10px}
.tile{background:var(--surface-2);border-radius:8px;padding:9px 14px;min-width:118px}
.tile b{display:block;font-size:19px;font-weight:650}
.tile span{font-size:11.5px;color:var(--text-secondary)}
.tile small{display:block;font-size:11px;color:var(--muted)}
.chart{margin:6px 0 4px}
svg text{font:11px "Segoe UI",Arial,sans-serif;fill:var(--text-secondary)}
svg .val{fill:var(--text-primary);font-weight:600}
.gridline{stroke:var(--line);stroke-width:1}
.legend{display:flex;flex-wrap:wrap;gap:16px;font-size:12px;color:var(--text-secondary);margin:2px 0 6px}
.legend i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:5px;vertical-align:-1px}
.crow{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:2px 0 6px}
.crow .legend{margin:0}
.seg{display:inline-flex;border:1px solid var(--line);border-radius:6px;overflow:hidden;margin-left:auto}
.seg button{font:inherit;font-size:12px;border:0;background:var(--surface-1);color:var(--text-secondary);padding:3px 12px;cursor:pointer}
.seg button.on{background:var(--surface-2);color:var(--text-primary);font-weight:600}
table{border-collapse:collapse;width:100%;font-size:12.5px}
th,td{border-bottom:1px solid var(--line);padding:4px 8px;text-align:right}
th:first-child,td:first-child{text-align:left}
td:nth-child(2),td:nth-child(3),td:nth-child(4){text-align:left}
.wide td{text-align:right}.wide td:first-child{text-align:left}
th{color:var(--text-secondary);font-weight:600;font-size:11.5px}
details{margin:2px 0 10px}summary{font-size:11.5px;color:var(--muted);cursor:pointer}
#tip{position:fixed;pointer-events:none;background:var(--surface-2);border:1px solid var(--line);
 border-radius:6px;padding:5px 9px;font-size:12px;display:none;z-index:9;box-shadow:0 4px 14px rgba(0,0,0,.18)}
.note{font-size:12px;color:var(--text-secondary)}
@media print{
 :root .viz-root,:root[data-theme="dark"] .viz-root{color-scheme:light;
  --surface-1:#fff;--surface-2:#f3f2ef;--text-primary:#0b0b0b;--text-secondary:#52514e;--muted:#8a887f;
  --line:#d8d6cf;--s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a;--bad:#b8352a}
 :root body,:root[data-theme="dark"] body{background:#fff}
 .viz-root{max-width:none;padding:0}
 #tip,.pick,.seg{display:none!important}
 [hidden]{display:none!important}
 h2{break-after:avoid}.chart{break-inside:avoid}}
</style>
<script src="/assets/ops-report-page.js"></script>
</head><body><div class="viz-root">
<div id="tip"></div>
<h1>Отчёт эксплуатации автопарка — планер</h1>
<div class="sub">Период ${data.from} — ${data.to} (конец не включается) · выручка без НДС по канону
 (наличные как есть, ИП ÷1,07, организации ÷1,22) · ${esc(park.canon)}</div>
<form class="pick" method="get">
  ${theme ? `<input type="hidden" name="theme" value="${theme}">` : ''}
  <label>с <input type="date" name="from" value="${data.from}"></label>
  <label>по <input type="date" name="to" value="${data.to}"></label>
  <button>Показать</button>
  <button type="button" id="themeBtn">🌙 Тёмная</button>
  <button type="button" id="pdfBtn">💾 Скачать PDF</button>
</form>
<div class="tiles">
<div class="tile"><span>Выручка без НДС</span><b>${(T.rev / 1e6).toFixed(1)} млн</b><small>${T.trips} рейсов за ${T.days} дн</small></div>
<div class="tile"><span>Техготовность · КТГ</span><b>${(T.fleet - data.downtime.repair.avg).toFixed(1)} маш</b><small>КТГ ${T.ktg}% из ${T.fleet} списочных</small></div>
<div class="tile"><span>На линии среднесуточно</span><b>${data.avgOnline} маш</b><small>КВЛ ${T.kvl}% по закрытым рейсам</small></div>
<div class="tile"><span>Под грузом · КИП</span><b>${(data.avgOnline * T.kip / 100).toFixed(1)} маш</b><small>КИП ${T.kip}% времени линии</small></div>
<div class="tile"><span>Прибытия на погрузку вовремя</span><b>${onP}%</b><small>${late.P.late1} опозд. &gt;1 ч из ${late.P.n}</small></div>
<div class="tile"><span>Прибытия на выгрузку вовремя</span><b>${onD}%</b><small>${late.D.late1} опозд. &gt;1 ч из ${late.D.n}</small></div>
</div>

<h2>КТГ · КВЛ · КИП в динамике, %</h2>
<div class="crow"><div class="legend"><span><i style="background:var(--s1)"></i>КТГ — техготовность</span><span><i style="background:var(--s2)"></i>КВЛ — выпуск на линию</span><span><i style="background:var(--s3)"></i>КИП — использование</span></div>${granSeg('kkk')}</div>
${granPair('kkk',
    linesSvg([D.ktg, D.kvl, D.kip], ['КТГ', 'КВЛ', 'КИП'], D.labels, D.tips, ['var(--s1)', 'var(--s2)', 'var(--s3)'], '%', 100),
    linesSvg([WK.ktg, WK.kvl, WK.kip], ['КТГ', 'КВЛ', 'КИП'], WK.labels, WK.tips, ['var(--s1)', 'var(--s2)', 'var(--s3)'], '%', 100, 1))}
<p class="note">техготовность и линия — среднесуточно (ремонт/выведенные из диспозиций, линия — живой ряд рейсов и перегонов), КИП — по закрытым рейсам; недели — пн–вс внутри периода.</p>

<h2>Простой парка по причинам — среднесуточно машин</h2>
<div class="tiles">${dtRow}</div>
<details><summary>кто в простое прямо сейчас (${idleNow.length})</summary>
<table><thead><tr><th>Машина</th><th>Водитель</th><th>Причина</th><th>Где</th><th>Свободна с</th></tr></thead>
<tbody>${idleRows}</tbody></table></details>

<h2>Выручка, млн ₽ без НДС</h2>
<div class="crow"><div class="legend"><span><i style="background:var(--s1)"></i>по дате выгрузки</span></div>${granSeg('rev')}</div>
${granPair('rev',
    barsSvg(D.rev, D.labels, D.tips, 'var(--s1)', ' млн ₽'),
    barsSvg(WK.rev, WK.labels, WK.tips, 'var(--s1)', ' млн ₽', 1))}

<h2>Машины на линии по дням</h2>
<div class="chart">${linesSvg([online], ['на линии'], D.labels, D.tips, ['var(--s1)'], ' машин')}</div>

<h2>Опоздания прибытий: доля &gt;1 ч по дням, %</h2>
<div class="legend"><span><i style="background:var(--s1)"></i>на погрузку</span><span><i style="background:var(--s2)"></i>на выгрузку</span></div>
<div class="chart">${linesSvg([late.P.byDayPct, late.D.byDayPct], ['погрузка', 'выгрузка'], D.labels, D.tips, ['var(--s1)', 'var(--s2)'], '%', 60)}</div>
<p class="note">медиана опоздания среди опоздавших: погрузка ${late.P.median} ч, выгрузка ${late.D.median} ч;
 опозданий &gt;3 ч: погрузка ${late.P.late3}, выгрузка ${late.D.late3}.</p>

<h2>Опоздания &gt;1 ч на ВЫГРУЗКУ — по клиентам</h2>
<div class="chart">${hbars(late.D.top, 'var(--s2)')}</div>
<h2>Опоздания &gt;1 ч на ПОГРУЗКУ — по клиентам</h2>
<div class="chart">${hbars(late.P.top, 'var(--s1)')}</div>

<h2>Недели: каскад КТГ · КВЛ · КИП</h2>
<table class="wide"><thead><tr><th>Неделя</th><th>Выручка, млн</th><th>Рейсов</th><th>КТГ %</th><th>КВЛ %</th><th>КИП %</th></tr></thead>
<tbody>${weeksRows}</tbody></table>

<h2>Топ клиентов по выручке без НДС</h2>
<table class="wide"><thead><tr><th>Клиент</th><th>Рейсов</th><th>Выручка, млн</th></tr></thead>
<tbody>${clientRows}</tbody></table>

</div></body></html>`;
}
