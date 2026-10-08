// ── ЕДИНЫЙ КАНОН ДЕНЕГ (закреплён руководителем; сведение 08.10) ──
// Любая выручка без НДС в продукте считается ТОЛЬКО этими функциями —
// той же формулой, что дашборд (public/assets/dashboard.js tripNet):
// ставка из «Настройки → Калькуляция» (не зашита), клиент-«ИП» — по
// слову целиком (ШИПУНОВ — не ИП), наличные — без НДС; «выгружено» —
// только статусы после выгрузки, дата = факт с фолбэком на расчётную.
// До сведения три поверхности считали тремя формулами и расходились.

const IP_RE = /(?<![\p{L}\p{N}])ИП(?![\p{L}\p{N}])/iu;

export const DONE_STATUSES = new Set(['unloaded', 'done', 'paid']);

export function calcSettings(db) {
  try {
    const row = db.prepare(`SELECT value_json FROM settings WHERE key='calculation'`).get();
    return row ? JSON.parse(row.value_json) : {};
  } catch { return {}; }
}

export function tripNet(trip, calc = {}) {
  const rate = trip.cash ? 0
    : IP_RE.test(String(trip.customer_name || ''))
      ? Number(calc.individualEntrepreneurVatRate ?? 0.07)
      : Number(calc.vatRate ?? 0.22);
  return Number(trip.revenue_vat || 0) / (1 + rate);
}

// Дата выгрузки рейса: факт, затем расчётная (как на дашборде).
export const doneDayOf = trip =>
  String(trip.unloaded_at || trip.ends_at || '').slice(0, 10);

// ── Прогноз месяца — серверный порт формулы дашборда ──
// Та же логика, что dashboardMetrics (реализм 14.09): факт прошедших
// дней + каждый оставшийся день по медиане выгрузок того же дня недели
// за 5 недель (кламп ×0,5…×1,5 к среднему темпу), но не меньше уже
// назначенного на день. Нужен для УТРЕННЕГО СНИМКА (решение
// руководителя 08.10): живой прогноз дышит от поздних отметок
// диспетчеров — руководителю показывается цифра, зафиксированная в
// 07:00, и она не меняется в течение дня.
export function forecastMonth(db, nowMs = Date.now()) {
  const DAY = 86_400_000;
  const now = new Date(nowMs);
  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const monthEnd = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  const calc = calcSettings(db);
  const trips = db.prepare(`SELECT status, cash, customer_name, revenue_vat,
    unloaded_at, ends_at FROM trips WHERE status<>'rejected'`).all();
  const doneTs = trip => Date.parse(trip.unloaded_at || trip.ends_at);
  let factPast = 0;
  const factByDay = new Map();
  for (const trip of trips) {
    if (!DONE_STATUSES.has(trip.status)) continue;
    const ts = doneTs(trip);
    if (ts >= monthStart && ts < dayStart) factPast += tripNet(trip, calc);
    if (ts >= dayStart - 35 * DAY && ts < dayStart) {
      const key = Math.floor(ts / DAY);
      factByDay.set(key, (factByDay.get(key) || 0) + tripNet(trip, calc));
    }
  }
  const bookedByDay = new Map();
  for (const trip of trips) {
    const ends = Date.parse(trip.ends_at);
    if (!(ends >= dayStart && ends < monthEnd)) continue;
    const key = Math.floor(ends / DAY);
    bookedByDay.set(key, (bookedByDay.get(key) || 0) + tripNet(trip, calc));
  }
  const avgHistDay = factByDay.size
    ? [...factByDay.values()].reduce((a, b) => a + b, 0) / factByDay.size : 0;
  const weekdayMedian = dow => {
    const list = [...factByDay.entries()]
      .filter(([key]) => new Date(key * DAY).getUTCDay() === dow)
      .map(([, value]) => value).sort((a, b) => a - b);
    if (!list.length) return avgHistDay;
    const median = list[Math.floor(list.length / 2)];
    return Math.min(avgHistDay * 1.5, Math.max(avgHistDay * 0.5, median));
  };
  let forecast;
  const dayOfMonth = now.getUTCDate();
  if (factByDay.size >= 14) {
    forecast = factPast;
    for (let ts = dayStart; ts < monthEnd; ts += DAY) {
      forecast += Math.max(bookedByDay.get(Math.floor(ts / DAY)) || 0,
        weekdayMedian(new Date(ts).getUTCDay()));
    }
  } else {
    forecast = dayOfMonth > 1 ? factPast / (dayOfMonth - 1)
      * Math.round((monthEnd - monthStart) / DAY) : factPast;
  }
  // Выручка последних трёх закрытых дней — для контроля «дооформлено
  // задним числом»: завтра те же дни пересчитаются, разница = поздние
  // отметки диспетчеров.
  const recentDays = {};
  for (let offset = 1; offset <= 3; offset += 1) {
    const ts = dayStart - offset * DAY;
    if (ts < monthStart - 3 * DAY) break;
    recentDays[new Date(ts).toISOString().slice(0, 10)] =
      Math.round(factByDay.get(Math.floor(ts / DAY)) || 0);
  }
  return { date: new Date(dayStart).toISOString().slice(0, 10),
    forecast: Math.round(forecast), factPast: Math.round(factPast), recentDays };
}
