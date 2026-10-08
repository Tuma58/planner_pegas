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
