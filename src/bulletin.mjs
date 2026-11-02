// ── Еженедельный «Вестник „Пегаса"» (решение руководителя 02.11.2026) ──
// Автоматическая газетная полоса по итогам недели: события + темп месяца.
// Публикуется объявлением на табло в понедельник 08:00 МСК на сутки.
// Деньги — ТОЛЬКО каноном (tripNet), километры — честные (журнал/трек).

import { DONE_STATUSES, calcSettings, tripNet } from './money.mjs';

const MSK = 3 * 3_600_000;
const DAY = 86_400_000;
const mskDay = ms => new Date(ms + MSK).toISOString().slice(0, 10);

// Прошлая неделя (пн–вс) и позапрошлая — для дельт.
export function weeklyBulletinData(db, nowMs = Date.now()) {
  const msk = new Date(nowMs + MSK);
  const monday = Date.UTC(msk.getUTCFullYear(), msk.getUTCMonth(), msk.getUTCDate())
    - ((msk.getUTCDay() + 6) % 7) * DAY - MSK; // пн 00:00 МСК текущей недели (UTC-мс)
  const from = monday - 7 * DAY;
  const calc = calcSettings(db);
  const trips = db.prepare(`SELECT status, cash, customer_name, revenue_vat, gps_km,
      distance_km, unloaded_at, ends_at, vehicle_id, from_zone_id, to_zone_id
    FROM trips WHERE status IN ('unloaded','done','paid')`).all();
  const doneMs = t => Date.parse(String(t.unloaded_at || t.ends_at || '')
    .replace(' ', 'T') + (String(t.unloaded_at || t.ends_at || '').includes('Z') ? '' : 'Z'));
  const weekOf = (a, b) => {
    const list = trips.filter(t => { const ms = doneMs(t); return ms >= a && ms < b; });
    const byDay = new Map();
    let net = 0;
    for (const t of list) {
      const v = tripNet(t, calc);
      net += v;
      const d = mskDay(doneMs(t));
      byDay.set(d, (byDay.get(d) || 0) + v);
    }
    const best = [...byDay.entries()].sort((x, y) => y[1] - x[1])[0] || null;
    const top = list.filter(t => Number(t.gps_km) > 0)
      .sort((x, y) => y.gps_km - x.gps_km)[0] || null;
    return { net, trips: list.length, best, top };
  };
  const cur = weekOf(from, monday);
  const prev = weekOf(from - 7 * DAY, from);
  // Опоздания на выгрузку: финальный стоп D с фактом против плана (>1 ч).
  const lateOf = (a, b) => db.prepare(`SELECT
      SUM(CASE WHEN julianday(s.actual_arrival) - julianday(s.planned_arrival) > 1.0/24
        THEN 1 ELSE 0 END) late, COUNT(*) facts
    FROM trips t JOIN trip_stops s ON s.trip_id=t.id
      AND s.seq=(SELECT MAX(seq) FROM trip_stops WHERE trip_id=t.id)
    WHERE t.status IN ('unloaded','done','paid') AND s.kind='D'
      AND s.actual_arrival IS NOT NULL AND s.planned_arrival IS NOT NULL
      AND datetime(COALESCE(t.unloaded_at,t.ends_at)) >= datetime(?)
      AND datetime(COALESCE(t.unloaded_at,t.ends_at)) < datetime(?)`)
    .get(new Date(a).toISOString(), new Date(b).toISOString());
  const late = lateOf(from, monday);
  const latePrev = lateOf(from - 7 * DAY, from);
  const pct = r => r.facts ? Math.round(r.late / r.facts * 100) : null;
  // Пробег парка за неделю — дневной журнал (честный трек).
  const kmOf = (a, b) => db.prepare(`SELECT COALESCE(SUM(COALESCE(can_km,km)),0) v
    FROM vehicle_daily_runs WHERE day >= ? AND day < ?`).get(mskDay(a), mskDay(b)).v;
  // Ремонт, машино-дни недели.
  const repairOf = (a, b) => Math.round(db.prepare(`SELECT COALESCE(SUM(
      julianday(MIN(ends_at, :b)) - julianday(MAX(starts_at, :a))), 0) d
    FROM vehicle_dispositions WHERE kind='repair' AND starts_at < :b AND ends_at > :a`)
    .get({ a: new Date(a).toISOString(), b: new Date(b).toISOString() }).d);
  // Перецепы недели: закрытые рейсы недели с 2+ звеньями.
  const relays = db.prepare(`SELECT COUNT(*) n FROM (
      SELECT s.trip_id FROM trip_segments s JOIN trips t ON t.id=s.trip_id
      WHERE datetime(COALESCE(t.unloaded_at,t.ends_at)) >= datetime(?)
        AND datetime(COALESCE(t.unloaded_at,t.ends_at)) < datetime(?)
      GROUP BY s.trip_id HAVING COUNT(*) >= 2)`)
    .get(new Date(from).toISOString(), new Date(monday).toISOString()).n;
  const topPlate = cur.top
    ? db.prepare(`SELECT plate FROM vehicles WHERE id=?`).get(cur.top.vehicle_id)?.plate : null;
  const topDir = cur.top ? db.prepare(`SELECT
      (SELECT name FROM zones z WHERE z.id=?) a, (SELECT name FROM zones z WHERE z.id=?) b`)
    .get(cur.top.from_zone_id, cur.top.to_zone_id) : null;
  // Темп месяца: план из revenue_plans, выгружено с 1-го числа по канону.
  const monthStart = Date.UTC(msk.getUTCFullYear(), msk.getUTCMonth(), 1) - MSK;
  const monthEnd = Date.UTC(msk.getUTCFullYear(), msk.getUTCMonth() + 1, 1) - MSK;
  const plan = Number(db.prepare(`SELECT target_net FROM revenue_plans WHERE period_start=?`)
    .get(mskDay(monthStart))?.target_net || 0);
  let monthNet = 0;
  for (const t of trips) {
    const ms = doneMs(t);
    if (ms >= monthStart && ms < nowMs) monthNet += tripNet(t, calc);
  }
  const daysLeft = Math.max(1, Math.ceil((monthEnd - nowMs) / DAY));
  return {
    from: mskDay(from), to: mskDay(monday - 1),
    net: Math.round(cur.net), netPrev: Math.round(prev.net), trips: cur.trips,
    avgCheck: cur.trips ? Math.round(cur.net / cur.trips) : 0,
    bestDay: cur.best ? { day: cur.best[0], net: Math.round(cur.best[1]) } : null,
    latePct: pct(late), latePrevPct: pct(latePrev),
    weekKm: Math.round(kmOf(from, monday)), weekKmPrev: Math.round(kmOf(from - 7 * DAY, from)),
    repairMd: repairOf(from, monday), repairMdPrev: repairOf(from - 7 * DAY, from),
    relays,
    topRun: cur.top && topPlate ? {
      plate: topPlate, km: Math.round(cur.top.gps_km),
      dir: topDir ? `${topDir.a || '?'} → ${topDir.b || '?'}` : ''
    } : null,
    month: {
      plan, done: Math.round(monthNet), daysLeft,
      needPerDay: plan > monthNet ? Math.round((plan - monthNet) / daysLeft) : 0
    }
  };
}

// ── Газетная полоса 1920×1080 (SVG, тот же почерк, что пилотный выпуск) ──
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const mln = v => (v / 1e6).toFixed(1).replace('.', ',');
const ruDate = d => `${d.slice(8, 10)}.${d.slice(5, 7)}`;
const sign = v => (v > 0 ? '+' : '') + v;

function wrapText(text, maxChars) {
  const out = [];
  let line = '';
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    const next = line ? line + ' ' + word : word;
    if (next.length > maxChars && line) { out.push(line); line = word; }
    else line = next;
  }
  if (line) out.push(line);
  return out;
}

export function renderBulletinSvg(d) {
  const W = 1920, H = 1080, M = 70;
  const INK = '#211d15', PAPER = '#f4efe3', ACCENT = '#1f6f54', WARM = '#8f2f24', RULE = '#8a8372';
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" fill="${PAPER}"/>`;
  const t = (x, y, size, text, { w = 400, anchor = 'start', fill = INK, italic = false } = {}) => {
    svg += `<text x="${x}" y="${y}" font-family="Georgia, serif" font-size="${size}" font-weight="${w}" text-anchor="${anchor}" fill="${fill}"${italic ? ' font-style="italic"' : ''}>${esc(text)}</text>`;
  };
  const line = (x1, y1, x2, y2, sw = 2, color = INK) => {
    svg += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${sw}"/>`;
  };
  line(M, 64, W - M, 64, 5); line(M, 70, W - M, 70, 1.5);
  t(W / 2, 136, 76, 'ВЕСТНИК «ПЕГАСА»', { w: 700, anchor: 'middle' });
  t(M, 176, 25, `Неделя ${ruDate(d.from)} – ${ruDate(d.to)}`, { italic: true });
  t(W - M, 176, 25, 'автоматический выпуск · факты из планера, без прикрас', { anchor: 'end', italic: true });
  line(M, 194, W - M, 194, 1.5); line(M, 200, W - M, 200, 5);

  t(M, 320, 118, `${mln(d.net)} млн ₽`, { w: 700 });
  const dNet = d.netPrev ? Math.round((d.net - d.netPrev) / 1e5) / 10 : null;
  t(M + 790, 285, 30, `выгружено за неделю без НДС${dNet != null ? ` · ${sign(dNet).replace('.', ',')} млн к прошлой` : ''}`);
  t(M + 790, 325, 30, `${d.trips} рейсов · средний чек ${d.avgCheck.toLocaleString('ru-RU')} ₽`);
  line(M, 360, W - M, 360, 2.5);

  const colW = (W - 2 * M - 2 * 56) / 3;
  const cols = [M, M + colW + 56, M + 2 * (colW + 56)];
  line(cols[1] - 28, 390, cols[1] - 28, 930, 1.2, RULE);
  line(cols[2] - 28, 390, cols[2] - 28, 930, 1.2, RULE);
  const LH = 36, SIZE = 26, CH = 42;

  // Колонка 1 — неделя в цифрах (с дельтами).
  let y = 436;
  t(cols[0], y, 34, 'Неделя в цифрах', { w: 700 }); y += 54;
  const rows = [];
  if (d.bestDay) rows.push(`Лучший день — ${ruDate(d.bestDay.day)}: ${mln(d.bestDay.net)} млн ₽.`);
  if (d.latePct != null) rows.push(`Опозданий на выгрузку ${d.latePct}%` +
    (d.latePrevPct != null ? ` (прошлая неделя — ${d.latePrevPct}%).` : '.'));
  rows.push(`Пробег парка ${Math.round(d.weekKm / 1000)} тыс. км` +
    (d.weekKmPrev ? ` (${sign(Math.round((d.weekKm - d.weekKmPrev) / 1000))} тыс. к прошлой).` : '.'));
  rows.push(`Ремонт: ${d.repairMd} машино-дней за неделю` +
    (d.repairMdPrev ? ` (прошлая — ${d.repairMdPrev}).` : '.'));
  for (const row of rows) {
    const lines = wrapText(row, CH - 2);
    lines.forEach((ln, i) => { t(cols[0] + (i ? 26 : 0), y, SIZE, i ? ln : '• ' + ln); y += LH; });
    y += 10;
  }

  // Колонка 2 — событие недели.
  y = 436;
  t(cols[1], y, 34, 'Событие недели', { w: 700 }); y += 54;
  const story = [];
  if (d.topRun) story.push(`Дальнобой недели — ${d.topRun.plate}: ${d.topRun.km.toLocaleString('ru-RU')} честных километров` +
    (d.topRun.dir ? ` по маршруту ${d.topRun.dir}.` : '.'));
  if (d.relays) story.push(`${d.relays} ${d.relays === 1 ? 'рейс доехал' : 'рейса доехали'} перецепом — машины подменяли друг друга, выручка поделена честно, по километрам каждого тягача.`);
  if (!story.length) story.push('Неделя прошла ровно: без перецепов и рекордов — и это тоже результат.');
  for (const para of story) {
    for (const ln of wrapText(para, CH)) { t(cols[1], y, SIZE, ln); y += LH; }
    y += 14;
  }

  // Колонка 3 — темп месяца.
  y = 436;
  t(cols[2], y, 34, 'Темп месяца', { w: 700, fill: ACCENT }); y += 54;
  const m = d.month;
  const mRows = m.plan
    ? [`Цель — ${mln(m.plan)} млн ₽.`,
      `Выгружено — ${mln(m.done)} млн (${Math.round(m.done / m.plan * 100)}%).`,
      `Осталось ${m.daysLeft} дн — дальше нужно по ${mln(m.needPerDay)} млн в день.`]
    : [`Выгружено с начала месяца — ${mln(m.done)} млн ₽.`];
  for (const row of mRows) {
    for (const ln of wrapText(row, CH - 2)) { t(cols[2], y, 27, ln, { w: 600 }); y += 40; }
    y += 8;
  }

  svg += `<rect x="${M}" y="962" width="${W - 2 * M}" height="86" fill="${ACCENT}" rx="6"/>`;
  t(M + 36, 1000, 34, m.plan ? `ЦЕЛЬ МЕСЯЦА — ${mln(m.plan)} МЛН ₽` : 'НОВАЯ НЕДЕЛЯ — НОВЫЙ СЧЁТ', { w: 700, fill: PAPER });
  t(M + 36, 1034, 24, m.plan ? `к утру понедельника выгружено ${mln(m.done)} млн · нужно по ${mln(m.needPerDay)} млн в день` : '', { fill: '#dcd5be' });
  t(W - M - 36, 1020, 27, 'Каждую цифру можно открыть и проверить в планере.', { anchor: 'end', fill: PAPER, w: 700 });
  svg += '</svg>';
  return svg;
}
