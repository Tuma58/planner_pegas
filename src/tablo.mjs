// Пульс табло (Э1 нового дашборда, 20.11.2026): «Показатели дня против
// своей нормы». Норма каждого показателя — ЖИВАЯ: медиана его же
// последних дней (без сегодняшнего), никакие пороги не зашиты; стрелка
// на плашке — сегодня против этой медианы, спарклайн — весь ряд.
// Дневные машино-дни считает канон resourceDayData (перегоны = работа),
// деньги — канон tripNet; своих формул у пульса нет.
import { resourceDayData } from './resource-day.mjs';
import { calcSettings, tripNet, DONE_STATUSES } from './money.mjs';

const DAY_MS = 86_400_000;
const MSK_MS = 3 * 3_600_000;
export const PULSE_DAYS = 14;

const median = list => {
  const clean = list.filter(value => Number.isFinite(value)).sort((a, b) => a - b);
  return clean.length ? clean[Math.floor(clean.length / 2)] : null;
};

// Чистая сборка плашек из дневных рядов — отдельно для тестов.
// row: { key, label, unit, better: 'up'|'down', series: [{day, value}] }.
// Сегодня сравнивается с медианой предыдущих дней; у счётчиков, где
// «меньше — лучше» (better='down'), знак дельты инвертируется в тон.
export function pulseQuotes(rows) {
  return rows.map(row => {
    const series = row.series;
    const today = series.at(-1)?.value ?? null;
    const norm = median(series.slice(0, -1).map(point => point.value));
    const delta = today != null && norm != null ? +(today - norm).toFixed(1) : null;
    const tone = delta == null || Math.abs(delta) < 1e-9 ? 'flat'
      : (delta > 0) === (row.better === 'up') ? 'good' : 'bad';
    return { key: row.key, label: row.label, unit: row.unit || '',
      value: today, norm, delta, tone, better: row.better,
      spark: series.map(point => point.value ?? 0) };
  });
}

// Лента событий (Э2, 20.11): пульс дня бегущей строкой — выгрузки,
// новые рейсы, выводы на линию, выходы из ремонта. Подпись рейса — по
// настройке tapeTripLabel: 'cities' (город погрузки → город выгрузки из
// точек рейса, фолбэк — зоны) либо 'customer' (клиент) — решение
// руководителя 20.11 «не зона/зона». Суммы вырезает роут по уровню денег.
export const TAPE_WINDOW_MS = 12 * 3_600_000;

const cityOf = point => {
  const head = String(point || '').split(',')[0].trim();
  // Тип населённого пункта бывает и префиксом («г. Пенза»), и суффиксом
  // («Москва г», «Лопатино с\п») — подпись ленты оставляет чистое имя.
  return head.replace(/^(г|город|пос|с|д|рп|пгт)\.?\s+/i, '')
    .replace(/\s+(г|город|пос|рп|пгт|с[\\/]п|д)\.?$/i, '').trim();
};

export function tabloTape(db, { nowMs = Date.now(), limit = 40 } = {}) {
  const calc = calcSettings(db);
  const labelMode = calc.tapeTripLabel === 'customer' ? 'customer' : 'cities';
  const sinceIso = new Date(nowMs - TAPE_WINDOW_MS).toISOString();
  const zones = new Map(db.prepare('SELECT id,name FROM zones').all().map(z => [z.id, z.name]));
  const events = [];
  const tsOf = value => {
    const raw = String(value || '').replace(' ', 'T');
    return Date.parse(raw + (raw.includes('Z') || raw.includes('+') ? '' : 'Z'));
  };

  const recent = db.prepare(`SELECT t.id, t.customer_name, t.from_zone_id, t.to_zone_id,
      t.revenue_vat, t.cash, t.created_at, t.on_line_at, t.unloaded_at, t.status,
      v.plate FROM trips t JOIN vehicles v ON v.id=t.vehicle_id
    WHERE t.status<>'rejected' AND (t.created_at>=? OR t.on_line_at>=? OR t.unloaded_at>=?)`)
    .all(sinceIso, sinceIso, sinceIso);
  // Города крайних точек одним запросом по затронутым рейсам.
  const stopRows = recent.length ? db.prepare(`SELECT trip_id, kind, point, seq FROM trip_stops
    WHERE trip_id IN (${recent.map(() => '?').join(',')}) ORDER BY trip_id, seq`)
    .all(...recent.map(trip => trip.id)) : [];
  const edges = new Map();
  for (const stop of stopRows) {
    const edge = edges.get(stop.trip_id) || {};
    if (stop.kind === 'P' && !edge.from) edge.from = cityOf(stop.point);
    if (stop.kind === 'D' && cityOf(stop.point)) edge.to = cityOf(stop.point);
    edges.set(stop.trip_id, edge);
  }
  const tripLabel = trip => {
    if (labelMode === 'customer' && String(trip.customer_name || '').trim()) {
      return String(trip.customer_name).trim();
    }
    const edge = edges.get(trip.id) || {};
    const from = edge.from || zones.get(trip.from_zone_id) || '';
    const to = edge.to || zones.get(trip.to_zone_id) || '';
    return from && to ? `${from} → ${to}` : String(trip.customer_name || '').trim() || trip.plate;
  };
  for (const trip of recent) {
    const net = Math.round(tripNet(trip, calc));
    const created = tsOf(trip.created_at);
    if (created >= nowMs - TAPE_WINDOW_MS) {
      events.push({ ts: created, kind: 'new_trip', tone: 'up',
        text: `новый рейс ${tripLabel(trip)}`, amount: net });
    }
    const onLine = tsOf(trip.on_line_at);
    if (onLine >= nowMs - TAPE_WINDOW_MS && onLine > created + 60_000) {
      events.push({ ts: onLine, kind: 'on_line', tone: 'up',
        text: `${trip.plate} вышла на линию · ${tripLabel(trip)}`, amount: null });
    }
    const unloaded = tsOf(trip.unloaded_at);
    if (unloaded >= nowMs - TAPE_WINDOW_MS) {
      events.push({ ts: unloaded, kind: 'unloaded', tone: 'up',
        text: `выгрузка ${tripLabel(trip)}`, amount: net });
    }
  }
  for (const row of db.prepare(`SELECT r.released_at, v.plate FROM repair_orders r
    JOIN vehicles v ON v.id=r.vehicle_id
    WHERE r.status='released' AND r.released_at>=?`).all(sinceIso)) {
    const ts = tsOf(row.released_at);
    if (Number.isFinite(ts)) {
      events.push({ ts, kind: 'repair_out', tone: 'up',
        text: `${row.plate} вышла из ремонта`, amount: null });
    }
  }
  return { labelMode,
    events: events.filter(event => Number.isFinite(event.ts))
      .sort((a, b) => b.ts - a.ts).slice(0, limit) };
}

export function tabloPulse(db, { nowMs = Date.now() } = {}) {
  const todayIso = new Date(nowMs + MSK_MS).toISOString().slice(0, 10);
  const days = [];
  for (let i = PULSE_DAYS - 1; i >= 0; i -= 1) {
    days.push(new Date(Date.parse(todayIso) - i * DAY_MS).toISOString().slice(0, 10));
  }

  // Ресурсные ряды — канон «Ресурса за день».
  const resource = days.map(day => {
    const r = resourceDayData(db, day);
    const online = (r.counters.line || 0) + (r.counters.transfer || 0);
    return { day, online, transfer: r.counters.transfer || 0,
      noCrew: r.counters.no_driver || 0, fleetWork: r.fleetWork || 0 };
  });

  // Деньги по дням — нетто выгрузок (плюс км для ставки), канон doneDay.
  const calc = calcSettings(db);
  const from = days[0];
  const byDay = new Map(days.map(day => [day, { net: 0, km: 0 }]));
  const doneDayOf = trip => {
    const raw = String(trip.unloaded_at || trip.ends_at || '').replace(' ', 'T');
    const ts = Date.parse(raw + (raw.includes('Z') || raw.includes('+') ? '' : 'Z'));
    return Number.isFinite(ts) ? new Date(ts + MSK_MS).toISOString().slice(0, 10) : '';
  };
  const trips = db.prepare(`SELECT revenue_vat, cash, customer_name, distance_km,
      unloaded_at, ends_at, status FROM trips
    WHERE status<>'rejected' AND COALESCE(unloaded_at, ends_at) >= ?`).all(`${from}`);
  for (const trip of trips) {
    if (!(DONE_STATUSES.has(trip.status) || trip.unloaded_at)) continue;
    const slot = byDay.get(doneDayOf(trip));
    if (!slot) continue;
    slot.net += tripNet(trip, calc);
    slot.km += Number(trip.distance_km || 0);
  }

  const seriesOf = pick => days.map(day => ({ day, value: pick(day) }));
  const resOf = day => resource.find(row => row.day === day);
  const quotes = pulseQuotes([
    { key: 'online', label: 'На линии', unit: 'ТС', better: 'up',
      series: seriesOf(day => resOf(day)?.online ?? null) },
    { key: 'keip', label: 'КЭИП', unit: '%', better: 'up',
      series: seriesOf(day => {
        const row = resOf(day);
        return row?.fleetWork ? +(row.online / row.fleetWork * 100).toFixed(1) : null;
      }) },
    { key: 'net', label: 'Нетто вчера', unit: 'млн', better: 'up',
      // Сегодняшний день ещё не отбит — сравниваем ВЧЕРА с его нормой.
      series: seriesOf(day => +(byDay.get(day).net / 1e6).toFixed(2)).slice(0, -1) },
    { key: 'rate', label: 'Ставка ₽/км', unit: '₽/км', better: 'up',
      series: seriesOf(day => {
        const slot = byDay.get(day);
        return slot.km > 0 ? Math.round(slot.net / slot.km) : null;
      }).slice(0, -1) },
    { key: 'nocrew', label: 'Без экипажа', unit: 'ТС', better: 'down',
      series: seriesOf(day => resOf(day)?.noCrew ?? null) },
    { key: 'transfer', label: 'Перегоны', unit: 'МД', better: 'down',
      series: seriesOf(day => resOf(day)?.transfer ?? null) }
  ]);
  return { today: todayIso, days, quotes };
}
