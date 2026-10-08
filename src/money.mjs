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

// ── Прогноз месяца — ПО ПЛАНОВЫМ ДАТАМ выгрузки ──
// Решение руководителя 08.10: прогноз не должен зависеть от фактов
// выгрузки (диспетчеры ставят отметки с опозданием, выручка переезжала
// между днями и цифра скакала). День рейса = расчётная дата ends_at,
// статус не важен (кроме отклонённых): прошедшие дни месяца — что
// должно было выгрузиться, будущие — не меньше забитого и не меньше
// медианы того же дня недели за 5 недель (кламп ×0,5…×1,5 к среднему).
// recentDays — ФАКТОВАЯ выручка последних дней: она здесь только для
// контроля «дооформлено задним числом» (дисциплина отметок).
export function forecastMonth(db, nowMs = Date.now()) {
  const DAY = 86_400_000;
  const now = new Date(nowMs);
  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const monthEnd = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  const calc = calcSettings(db);
  const trips = db.prepare(`SELECT status, cash, customer_name, revenue_vat,
    unloaded_at, ends_at FROM trips WHERE status<>'rejected'`).all();
  // Плановый день: расчётная дата выгрузки — отметки её не двигают.
  let plannedPast = 0;
  const plannedByDay = new Map();
  const factByDay = new Map();
  for (const trip of trips) {
    const ends = Date.parse(trip.ends_at);
    if (Number.isFinite(ends) && ends >= dayStart - 35 * DAY && ends < monthEnd) {
      const key = Math.floor(ends / DAY);
      plannedByDay.set(key, (plannedByDay.get(key) || 0) + tripNet(trip, calc));
      if (ends >= monthStart && ends < dayStart) plannedPast += tripNet(trip, calc);
    }
    // Фактовый слой — только для recentDays (контроль поздних отметок).
    if (DONE_STATUSES.has(trip.status)) {
      const ts = Date.parse(trip.unloaded_at || trip.ends_at);
      if (ts >= dayStart - 35 * DAY && ts < dayStart) {
        const key = Math.floor(ts / DAY);
        factByDay.set(key, (factByDay.get(key) || 0) + tripNet(trip, calc));
      }
    }
  }
  const histDays = [...plannedByDay.keys()].filter(key => key * DAY < dayStart);
  const avgHistDay = histDays.length
    ? histDays.reduce((sum, key) => sum + plannedByDay.get(key), 0) / histDays.length : 0;
  const weekdayMedian = dow => {
    const list = histDays
      .filter(key => new Date(key * DAY).getUTCDay() === dow)
      .map(key => plannedByDay.get(key)).sort((a, b) => a - b);
    if (!list.length) return avgHistDay;
    const median = list[Math.floor(list.length / 2)];
    return Math.min(avgHistDay * 1.5, Math.max(avgHistDay * 0.5, median));
  };
  let forecast;
  const dayOfMonth = now.getUTCDate();
  if (histDays.length >= 14) {
    forecast = plannedPast;
    for (let ts = dayStart; ts < monthEnd; ts += DAY) {
      forecast += Math.max(plannedByDay.get(Math.floor(ts / DAY)) || 0,
        weekdayMedian(new Date(ts).getUTCDay()));
    }
  } else {
    forecast = dayOfMonth > 1 ? plannedPast / (dayOfMonth - 1)
      * Math.round((monthEnd - monthStart) / DAY) : plannedPast;
  }
  const recentDays = {};
  for (let offset = 1; offset <= 3; offset += 1) {
    const ts = dayStart - offset * DAY;
    recentDays[new Date(ts).toISOString().slice(0, 10)] =
      Math.round(factByDay.get(Math.floor(ts / DAY)) || 0);
  }
  return { date: new Date(dayStart).toISOString().slice(0, 10),
    forecast: Math.round(forecast), plannedPast: Math.round(plannedPast), recentDays };
}
