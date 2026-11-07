// «Склад запчастей ТОиР» — этап 1 (чек-лист продукта Б2.13, 07.11.2026):
// инструмент должностей «Менеджер по закупке запчастей», «Кладовщик»,
// «Снабженец». Номенклатура → остатки → приход от поставщика (с ценой) →
// расход на заказ-наряд Ремзоны (repair_orders) → неснижаемый запас →
// список «к закупке» и заявки поставщику.
//
// Остаток не хранится — он сумма журнала движений parts_moves (приход +,
// расход −, инвентаризация ±); отмена движения — сторно-флаг, строки не
// удаляются (история для нормативов и аудита).
//
// Живые нормативы (CLAUDE.md): своих бизнес-констант нет.
//   • Неснижаемый запас = расход позиции в сутки × срок поставки ×
//     коэффициент запаса, но не меньше медианы разовой выдачи (иначе
//     редкая «выдача комплектом» — 4 колеса, 6 литров — не обслужится).
//     Расход в сутки = сумма выдач за окно / окно (сутки).
//   • Срок поставки выучивается из факта «заявка поставщику → приход»
//     (parts_requests): медиана по позиции при числе фактов ≥ минимума;
//     фактов мало — ручной срок позиции; его нет — медиана по всему складу
//     (тот же минимум фактов); нет и её — срок неизвестен, запас не
//     считается, позиция честно помечена «нет срока поставки».
//     Факт вне коридора (клампа) в медиану не входит и виден в отчёте.
//   • Ручной минимум позиции ВСЕГДА переопределяет живой (живой при этом
//     считается рядом — дрейф виден).
//   • Окно, минимум фактов, коридор срока, коэффициент запаса — ЦЕЛИ
//     руководителя: settings.parts (Склад → «Нормативы»). Пусто → цель по
//     умолчанию (ниже); ноль — осознанное значение (коэффициент 0 —
//     «запас не держим», остаётся только ручной минимум).
// Деньги: цена прихода — «как в документе» с флагом НДС; себестоимость
// выдачи — без НДС (канон: ставка settings.calculation.vatRate, как в
// журнале затрат), средневзвешенная цена приходов на момент выдачи —
// снимок пишется в строку выдачи, история не плывёт.
import { randomUUID } from 'node:crypto';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
const EPS = 1e-9;

// Цели по умолчанию — подставляются ТОЛЬКО вместо пустоты в settings.parts.
// Окно 90 сут: запчасти расходуются редко, месячное окно даёт нули;
// коридор срока 1–60 сут: поставка «день в день» и «больше двух месяцев»
// — вырожденные данные (ошибка дат заявки), а не норма.
export const PARTS_DEFAULTS = {
  windowDays: 90, minLeadSamples: 3, leadMinDays: 1, leadMaxDays: 60,
  safetyFactor: 1, expenseOnIssue: false
};

export const MOVE_KIND_LABEL = { receipt: 'приход', issue: 'расход на наряд', adjust: 'инвентаризация' };
// Наряд принимает запчасти, пока он открыт (очередь, в работе, готов).
export const ISSUE_ORDER_STATUSES = ['queued', 'in_progress', 'ready'];

export function migrateParts(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS parts_items (
    id TEXT PRIMARY KEY, code TEXT NOT NULL DEFAULT '', name TEXT NOT NULL,
    unit TEXT NOT NULL DEFAULT 'шт', category TEXT NOT NULL DEFAULT '', supplier TEXT NOT NULL DEFAULT '',
    manual_min REAL CHECK(manual_min IS NULL OR manual_min >= 0),
    lead_days_manual REAL CHECK(lead_days_manual IS NULL OR lead_days_manual >= 0),
    note TEXT NOT NULL DEFAULT '', archived_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by_name TEXT NOT NULL DEFAULT '')`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_parts_items_name ON parts_items(name)`);
  db.exec(`CREATE TABLE IF NOT EXISTS parts_requests (
    id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES parts_items(id),
    qty REAL NOT NULL CHECK(qty > 0), supplier TEXT NOT NULL DEFAULT '',
    requested_on TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','received','cancelled')),
    received_on TEXT, receipt_id TEXT, note TEXT NOT NULL DEFAULT '',
    created_by_name TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_parts_requests_item ON parts_requests(item_id, status)`);
  db.exec(`CREATE TABLE IF NOT EXISTS parts_moves (
    id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES parts_items(id),
    kind TEXT NOT NULL CHECK(kind IN ('receipt','issue','adjust')),
    qty REAL NOT NULL, price REAL CHECK(price IS NULL OR price >= 0), vat INTEGER NOT NULL DEFAULT 1,
    unit_cost_net REAL, supplier TEXT NOT NULL DEFAULT '', doc_ref TEXT NOT NULL DEFAULT '',
    order_id TEXT REFERENCES repair_orders(id), vehicle_id TEXT, request_id TEXT,
    day TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
    created_by TEXT, created_by_name TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    cancelled_at TEXT, cancelled_by_name TEXT NOT NULL DEFAULT '', cancel_reason TEXT NOT NULL DEFAULT '',
    CHECK(kind = 'adjust' OR qty > 0),
    CHECK(kind <> 'issue' OR order_id IS NOT NULL),
    CHECK(kind <> 'adjust' OR length(trim(note)) > 0))`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_parts_moves_item ON parts_moves(item_id, kind, day)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_parts_moves_order ON parts_moves(order_id)`);
}

// ── Даты ──
const addDays = (day, days) => new Date(Date.parse(`${day}T00:00:00Z`) + Number(days) * DAY_MS).toISOString().slice(0, 10);
const daysBetween = (fromDay, toDay) => (Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) / DAY_MS;

// «Сегодня» в часовом поясе планирования (Настройки → Общие → timezone).
export function partsToday(settings, nowMs = Date.now()) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: settings?.general?.timezone || undefined,
      year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(nowMs));
  } catch { return new Date(nowMs).toISOString().slice(0, 10); }
}

export function median(values) {
  const list = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!list.length) return null;
  const mid = Math.floor(list.length / 2);
  return list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
}
const round2 = value => Math.round(value * 100) / 100;
const ceilQty = value => Math.ceil(value - EPS);

// ── Цели склада (settings.parts) ──
// Пустота → цель по умолчанию; ноль и любое корректное число — как задано.
export function partsConfig(settings) {
  const raw = settings?.parts || {};
  const num = (key, ok) => {
    const value = raw[key];
    if (value === '' || value == null) return PARTS_DEFAULTS[key];
    const n = Number(value);
    return Number.isFinite(n) && ok(n) ? n : PARTS_DEFAULTS[key];
  };
  const cfg = {
    windowDays: Math.round(num('windowDays', n => n >= 1)),
    minLeadSamples: Math.round(num('minLeadSamples', n => n >= 1)),
    leadMinDays: num('leadMinDays', n => n >= 0),
    leadMaxDays: num('leadMaxDays', n => n > 0),
    safetyFactor: num('safetyFactor', n => n >= 0),
    expenseOnIssue: raw.expenseOnIssue === true
  };
  if (cfg.leadMaxDays < cfg.leadMinDays) { cfg.leadMinDays = PARTS_DEFAULTS.leadMinDays; cfg.leadMaxDays = PARTS_DEFAULTS.leadMaxDays; }
  return cfg;
}

// Факты срока поставки: дни «заявка → приход» по закрытым заявкам.
// Возвращает { ok: [дни в коридоре], rejected: число отвергнутых клампом }.
export function leadSamples(rows, cfg) {
  const ok = [];
  let rejected = 0;
  for (const row of rows) {
    if (!DAY_RE.test(row.requested_on || '') || !DAY_RE.test(row.received_on || '')) continue;
    const days = daysBetween(row.requested_on, row.received_on);
    if (days >= cfg.leadMinDays - EPS && days <= cfg.leadMaxDays + EPS) ok.push(days);
    else rejected += 1;
  }
  return { ok, rejected };
}

// Срок поставки позиции: факт позиции → ручной позиции → факт склада → нет.
export function leadTimeOf({ itemSamples, manualDays, parkSamples, cfg }) {
  const base = { samples: itemSamples.ok.length, rejected: itemSamples.rejected };
  if (itemSamples.ok.length >= cfg.minLeadSamples) {
    return { ...base, days: median(itemSamples.ok), source: 'learned' };
  }
  if (manualDays != null && Number.isFinite(Number(manualDays))) {
    return { ...base, days: Number(manualDays), source: 'manual' };
  }
  if (parkSamples && parkSamples.ok.length >= cfg.minLeadSamples) {
    return { ...base, days: median(parkSamples.ok), source: 'park' };
  }
  return { ...base, days: null, source: 'none' };
}

// Неснижаемый запас позиции.
//   issues — количества выдач за окно (только не отменённые);
//   leadDays — срок поставки (null — неизвестен); manualMin — ручной минимум.
// Возвращает { qty, source: manual|live|no_use|no_lead, live, dailyUse, used, medianIssue }.
export function minStockOf({ issues, windowDays, leadDays, safetyFactor, manualMin }) {
  const used = issues.reduce((sum, qty) => sum + qty, 0);
  const dailyUse = windowDays > 0 ? used / windowDays : 0;
  const medianIssue = median(issues);
  let live = null;
  let liveSource = 'no_use';
  if (used > EPS) {
    if (leadDays == null) liveSource = 'no_lead';
    else {
      live = ceilQty(Math.max(dailyUse * leadDays * safetyFactor, safetyFactor > 0 ? medianIssue : 0));
      liveSource = 'live';
    }
  } else live = 0; // расхода за окно не было — живой минимум ноль (держать нечего)
  const base = { live, dailyUse: round2(dailyUse * 1000) / 1000, used: round2(used), medianIssue };
  if (manualMin != null && Number.isFinite(Number(manualMin))) return { ...base, qty: Number(manualMin), source: 'manual' };
  return { ...base, qty: liveSource === 'no_lead' ? null : live, source: liveSource };
}

// К закупке: не хватает до неснижаемого с учётом уже заказанного.
export function toBuyQty(minQty, stock, onOrder) {
  if (minQty == null) return 0;
  const gap = minQty - stock - onOrder;
  return gap > EPS ? ceilQty(gap) : 0;
}

const vatRateOf = settings => Number(settings?.calculation?.vatRate ?? 0.22);
export const netPrice = (price, vat, vatRate) => price == null ? null : vat ? price / (1 + vatRate) : price;

// ── Сводка склада ──
export function partsStock(db, { settings = {}, today = partsToday(settings), includeArchived = false } = {}) {
  const cfg = partsConfig(settings);
  const fromDay = addDays(today, -cfg.windowDays);
  const items = db.prepare(`SELECT * FROM parts_items ${includeArchived ? '' : 'WHERE archived_at IS NULL'}
    ORDER BY name COLLATE NOCASE`).all();
  const stock = new Map(db.prepare(`SELECT item_id, SUM(CASE kind WHEN 'issue' THEN -qty ELSE qty END) s
    FROM parts_moves WHERE cancelled_at IS NULL GROUP BY item_id`).all().map(row => [row.item_id, row.s || 0]));
  const cost = new Map(db.prepare(`SELECT item_id, SUM(qty*unit_cost_net) v, SUM(qty) q FROM parts_moves
    WHERE kind='receipt' AND cancelled_at IS NULL AND unit_cost_net IS NOT NULL GROUP BY item_id`).all()
    .map(row => [row.item_id, row.q > 0 ? row.v / row.q : null]));
  const issues = new Map();
  for (const row of db.prepare(`SELECT item_id, qty FROM parts_moves WHERE kind='issue' AND cancelled_at IS NULL
      AND day > ? AND day <= ?`).all(fromDay, today)) {
    if (!issues.has(row.item_id)) issues.set(row.item_id, []);
    issues.get(row.item_id).push(row.qty);
  }
  const firstMove = new Map(db.prepare(`SELECT item_id, MIN(day) d FROM parts_moves WHERE cancelled_at IS NULL GROUP BY item_id`)
    .all().map(row => [row.item_id, row.d]));
  const closed = db.prepare(`SELECT item_id, requested_on, received_on FROM parts_requests WHERE status='received'`).all();
  const parkSamples = leadSamples(closed, cfg);
  const byItemReq = new Map();
  for (const row of closed) {
    if (!byItemReq.has(row.item_id)) byItemReq.set(row.item_id, []);
    byItemReq.get(row.item_id).push(row);
  }
  const onOrder = new Map(db.prepare(`SELECT item_id, SUM(qty) q, COUNT(*) n FROM parts_requests WHERE status='open' GROUP BY item_id`)
    .all().map(row => [row.item_id, { qty: row.q || 0, count: row.n }]));
  const list = items.map(item => {
    const lead = leadTimeOf({ itemSamples: leadSamples(byItemReq.get(item.id) || [], cfg),
      manualDays: item.lead_days_manual, parkSamples, cfg });
    const min = minStockOf({ issues: issues.get(item.id) || [], windowDays: cfg.windowDays, leadDays: lead.days,
      safetyFactor: cfg.safetyFactor, manualMin: item.manual_min });
    const qty = round2(stock.get(item.id) || 0);
    const ordered = onOrder.get(item.id) || { qty: 0, count: 0 };
    const avgCost = cost.get(item.id) ?? null;
    const first = firstMove.get(item.id);
    return { id: item.id, code: item.code, name: item.name, unit: item.unit, category: item.category,
      supplier: item.supplier, note: item.note, archived: Boolean(item.archived_at),
      manualMin: item.manual_min, leadDaysManual: item.lead_days_manual,
      stock: qty, onOrder: round2(ordered.qty), openRequests: ordered.count,
      lead: { ...lead, days: lead.days == null ? null : round2(lead.days) }, min,
      // История позиции короче окна — расход в сутки занижен, это видно.
      windowFull: Boolean(first && first <= fromDay),
      below: min.qty != null && qty < min.qty - EPS,
      toBuy: toBuyQty(min.qty, qty, ordered.qty),
      avgCost: avgCost == null ? null : round2(avgCost), stockValue: avgCost == null ? null : Math.round(avgCost * Math.max(qty, 0)) };
  });
  const toBuy = list.filter(item => item.toBuy > 0);
  return { today, cfg, parkLead: { days: parkSamples.ok.length >= cfg.minLeadSamples ? round2(median(parkSamples.ok)) : null,
    samples: parkSamples.ok.length, rejected: parkSamples.rejected }, items: list,
    totals: { items: list.length, below: list.filter(item => item.below).length, toBuy: toBuy.length,
      empty: list.filter(item => item.stock <= EPS).length,
      openRequests: list.reduce((sum, item) => sum + item.openRequests, 0),
      stockValue: list.reduce((sum, item) => sum + (item.stockValue || 0), 0),
      noCost: list.filter(item => item.stock > EPS && item.avgCost == null).length,
      buyCost: Math.round(toBuy.reduce((sum, item) => sum + (item.avgCost || 0) * item.toBuy, 0)),
      noLead: list.filter(item => item.min.source === 'no_lead').length } };
}

// Отчёт о дрейфе нормативов склада — строка для «📐 Нормативы недели».
// Сравнение с прошлым снимком (app_meta 'parts_norms_week') — по покрытию.
export function partsNormsReport(db, { settings = {}, today = partsToday(settings), save = false } = {}) {
  const data = partsStock(db, { settings, today });
  const count = key => data.items.filter(item => item.lead.source === key).length;
  const report = {
    today, items: data.items.length, withUse: data.items.filter(item => item.min.used > 0).length,
    lead: { learned: count('learned'), manual: count('manual'), park: count('park'), none: count('none') },
    minManual: data.items.filter(item => item.min.source === 'manual').length,
    noLead: data.totals.noLead, below: data.totals.below, toBuy: data.totals.toBuy,
    parkLead: data.parkLead,
    rejected: data.items.reduce((sum, item) => sum + item.lead.rejected, 0),
    // Ручной минимум расходится с живым — повод пересмотреть руками.
    manualVsLive: data.items.filter(item => item.min.source === 'manual' && item.min.live != null && item.min.live !== item.min.qty)
      .map(item => ({ id: item.id, name: item.name, manual: item.min.qty, live: item.min.live }))
  };
  let last = null;
  try { last = JSON.parse(db.prepare(`SELECT value FROM app_meta WHERE key='parts_norms_week'`).get()?.value || 'null'); } catch { last = null; }
  const delta = (now, was) => was == null || now === was ? '' : ` (${now > was ? '+' : ''}${now - was})`;
  report.line = `🔩 Склад запчастей: ${report.items} позиций, расход за ${data.cfg.windowDays} сут у ${report.withUse}` +
    ` · срок поставки выучен у ${report.lead.learned}${delta(report.lead.learned, last?.lead?.learned)}, ручной ${report.lead.manual},` +
    ` по складу ${report.lead.park}, неизвестен ${report.lead.none}` +
    (report.parkLead.days != null ? ` · медиана поставки склада ${report.parkLead.days} сут (${report.parkLead.samples} фактов)` : '') +
    (report.rejected ? ` · отвергнуто коридором ${data.cfg.leadMinDays}–${data.cfg.leadMaxDays} сут: ${report.rejected}` : '') +
    ` · ниже минимума ${report.below}${delta(report.below, last?.below)}, к закупке ${report.toBuy}` +
    (report.manualVsLive.length ? ` · ручной минимум ≠ живому у ${report.manualVsLive.length}` : '');
  if (save) {
    db.prepare(`INSERT INTO app_meta(key,value) VALUES('parts_norms_week',?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(JSON.stringify({ at: new Date().toISOString(), ...report, manualVsLive: undefined }));
  }
  return report;
}

// ── Хук в журнал затрат ──
// Расход запчасти на наряд по смыслу — затрата ТОиР на машину (статья
// «Запчасти», ЦФО toir). Журнал НЕ дублируется: хук пишет ОДНУ строку
// expenses на выдачу с отпечатком import_key 'parts:issue:<id>' (повтор
// молча глотается уникальным индексом), сумма — без НДС (vat=0).
// Включается целью settings.parts.expenseOnIssue: если журнал уже ведёт
// закупку запчастей по счетам поставщиков (Dornet «store», ручной ввод),
// включение даст двойной счёт — решает руководитель (см. отчёт).
export const issueExpenseKey = moveId => `parts:issue:${moveId}`;

export function partsIssueExpense(db, moveId, { userId = null } = {}) {
  const move = db.prepare(`SELECT m.*, i.name item_name, i.unit FROM parts_moves m JOIN parts_items i ON i.id=m.item_id
    WHERE m.id=? AND m.kind='issue'`).get(moveId);
  if (!move) return { ok: false, reason: 'not_issue' };
  if (move.cancelled_at) return { ok: false, reason: 'cancelled' };
  if (move.unit_cost_net == null) return { ok: false, reason: 'no_cost' };
  let category = null;
  try { category = db.prepare(`SELECT id, active FROM expense_categories WHERE id='parts'`).get(); } catch { category = null; }
  if (!category || !category.active) return { ok: false, reason: 'no_category' };
  const key = issueExpenseKey(moveId);
  const existing = db.prepare('SELECT id FROM expenses WHERE import_key=?').get(key);
  if (existing) return { ok: true, expenseId: existing.id, existed: true };
  const order = move.order_id ? db.prepare('SELECT purpose FROM repair_orders WHERE id=?').get(move.order_id) : null;
  const id = randomUUID();
  db.prepare(`INSERT INTO expenses(id,spent_on,category_id,amount,vat,vehicle_id,supplier,doc_ref,note,source,import_key,created_by)
    VALUES(?,?,?,?,0,?,?,?,?,'api',?,?)`).run(id, move.day, 'parts', round2(move.qty * move.unit_cost_net),
    move.vehicle_id || null, 'Склад запчастей', `наряд ${String(move.order_id || '').slice(0, 8)}${order ? ` · ${order.purpose}` : ''}`,
    `${move.item_name} × ${move.qty} ${move.unit}`.slice(0, 300), key, userId);
  return { ok: true, expenseId: id };
}

export function partsIssueExpenseRemove(db, moveId) {
  try { return db.prepare('DELETE FROM expenses WHERE import_key=?').run(issueExpenseKey(moveId)).changes; } catch { return 0; }
}

// Запчасти наряда — для карточки наряда Ремзоны и карточки ТС.
export function partsForOrder(db, orderId) {
  return db.prepare(`SELECT m.id, m.item_id, i.name, i.code, i.unit, m.qty, m.unit_cost_net, m.day, m.note, m.created_by_name
    FROM parts_moves m JOIN parts_items i ON i.id=m.item_id
    WHERE m.order_id=? AND m.kind='issue' AND m.cancelled_at IS NULL ORDER BY m.created_at`).all(orderId)
    .map(row => ({ ...row, cost: row.unit_cost_net == null ? null : round2(row.qty * row.unit_cost_net) }));
}

// Стоимость выданных запчастей по машинам за период (без НДС) — для ЦФО
// ТОиР / карточки ТС, если журнал затрат запчасти по выдаче не ведёт.
export function partsCostByVehicle(db, from, to) {
  return db.prepare(`SELECT vehicle_id, SUM(qty*unit_cost_net) cost, COUNT(*) n,
      SUM(CASE WHEN unit_cost_net IS NULL THEN 1 ELSE 0 END) no_cost
    FROM parts_moves WHERE kind='issue' AND cancelled_at IS NULL AND day>=? AND day<=? GROUP BY vehicle_id`).all(from, to)
    .map(row => ({ vehicleId: row.vehicle_id, cost: Math.round(row.cost || 0), count: row.n, noCost: row.no_cost }));
}

// ── Нормализация входа ──
const str = (value, max = 500) => String(value ?? '').trim().slice(0, max);
const numOrNull = value => value === '' || value == null ? null : Number(value);
const dayOr = (value, fallback) => DAY_RE.test(String(value || '')) ? String(value) : fallback;

export function itemFromBody(body, current = {}) {
  const pick = (camel, snake) => body[camel] !== undefined ? body[camel] : body[snake] !== undefined ? body[snake] : current[snake];
  return {
    code: str(pick('code', 'code'), 80), name: str(pick('name', 'name'), 200),
    unit: str(pick('unit', 'unit'), 20) || 'шт', category: str(pick('category', 'category'), 120),
    supplier: str(pick('supplier', 'supplier'), 200), note: str(pick('note', 'note'), 1000),
    manual_min: numOrNull(pick('manualMin', 'manual_min')), lead_days_manual: numOrNull(pick('leadDaysManual', 'lead_days_manual'))
  };
}

export function itemError(item) {
  if (!item.name) return 'Укажите наименование';
  if (item.manual_min != null && !(item.manual_min >= 0)) return 'Ручной минимум — число не меньше нуля (пусто — живой норматив)';
  if (item.lead_days_manual != null && !(item.lead_days_manual >= 0)) return 'Срок поставки — число дней не меньше нуля';
  return '';
}

// ── Доступ ──
// Наборы ролей: экран 'parts'; правка — у кого fleet:write (ТОиР).
// Старая модель: fleet:write — читает и пишет, reports:read — только читает
// (руководитель, как у Ремзоны). Цели склада — settings:write.
export function partsRights({ user, access, hasPermission }) {
  if (!user) return { read: false, write: false, settings: false, money: false };
  const legacy = !access || access.legacy;
  const write = hasPermission(user, 'fleet:write');
  const read = legacy ? write || hasPermission(user, 'reports:read') : (access.views || []).includes('parts');
  return { read, write: read && write, settings: read && hasPermission(user, 'settings:write'),
    money: (access?.money ?? 'full') !== 'none' };
}

const MONEY_KEYS = new Set(['price', 'unit_cost_net', 'unitCost', 'avgCost', 'stockValue', 'buyCost', 'cost', 'amount', 'vat']);
export function stripPartsMoney(value) {
  if (Array.isArray(value)) return value.map(stripPartsMoney);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([key]) => !MONEY_KEYS.has(key))
      .map(([key, item]) => [key, stripPartsMoney(item)]));
  }
  return value;
}

// ── Движения ──
const stockOf = (db, itemId) => db.prepare(`SELECT COALESCE(SUM(CASE kind WHEN 'issue' THEN -qty ELSE qty END),0) s
  FROM parts_moves WHERE item_id=? AND cancelled_at IS NULL`).get(itemId).s;
const avgCostOf = (db, itemId) => {
  const row = db.prepare(`SELECT SUM(qty*unit_cost_net) v, SUM(qty) q FROM parts_moves
    WHERE item_id=? AND kind='receipt' AND cancelled_at IS NULL AND unit_cost_net IS NOT NULL`).get(itemId);
  return row?.q > 0 ? row.v / row.q : null;
};
const activeItem = (db, id) => db.prepare('SELECT * FROM parts_items WHERE id=? AND archived_at IS NULL').get(String(id || ''));

// Приход. withMoney=false — цена не принимается (роль цен не видит).
export function addReceipt(db, body, { user, today, vatRate, withMoney }) {
  const item = activeItem(db, body.itemId);
  if (!item) return { status: 422, error: 'Выберите позицию склада' };
  const qty = Number(body.qty);
  if (!(qty > 0)) return { status: 422, error: 'Количество прихода — больше нуля' };
  let price = withMoney ? numOrNull(body.price) : null;
  if (price != null && !(price >= 0)) return { status: 422, error: 'Цена — число не меньше нуля' };
  const vat = body.vat === undefined ? 1 : (body.vat ? 1 : 0);
  let request = null;
  if (body.requestId) {
    request = db.prepare(`SELECT * FROM parts_requests WHERE id=?`).get(String(body.requestId));
    if (!request || request.item_id !== item.id) return { status: 422, error: 'Заявка не найдена для этой позиции' };
    if (request.status !== 'open') return { status: 409, error: 'Заявка уже закрыта' };
  }
  const day = dayOr(body.day, today);
  if (day > today) return { status: 422, error: 'Приход будущим днём не принимается' };
  if (request && day < request.requested_on) return { status: 422, error: 'Приход раньше даты заявки' };
  const id = randomUUID();
  const supplier = str(body.supplier, 200) || request?.supplier || item.supplier || '';
  price = price == null ? null : round2(price);
  db.prepare(`INSERT INTO parts_moves(id,item_id,kind,qty,price,vat,unit_cost_net,supplier,doc_ref,request_id,day,note,created_by,created_by_name)
    VALUES(?,?,'receipt',?,?,?,?,?,?,?,?,?,?,?)`).run(id, item.id, round2(qty), price, vat,
    price == null ? null : netPrice(price, vat, vatRate), supplier, str(body.docRef, 120), request?.id || null, day,
    str(body.note, 500), user?.id || null, user?.full_name || user?.username || '');
  if (request) {
    db.prepare(`UPDATE parts_requests SET status='received', received_on=?, receipt_id=? WHERE id=?`).run(day, id, request.id);
  }
  return { status: 201, id, requestClosed: Boolean(request) };
}

// Расход на заказ-наряд Ремзоны: наряд открыт, на складе хватает.
export function addIssue(db, body, { user, today }) {
  const item = activeItem(db, body.itemId);
  if (!item) return { status: 422, error: 'Выберите позицию склада' };
  const qty = Number(body.qty);
  if (!(qty > 0)) return { status: 422, error: 'Количество расхода — больше нуля' };
  const order = db.prepare('SELECT id, vehicle_id, status FROM repair_orders WHERE id=?').get(String(body.orderId || ''));
  if (!order) return { status: 422, error: 'Выберите заказ-наряд Ремзоны' };
  if (!ISSUE_ORDER_STATUSES.includes(order.status)) return { status: 409, error: 'Наряд закрыт — запчасти выдаются только на открытый наряд' };
  const stock = stockOf(db, item.id);
  if (qty > stock + EPS) return { status: 409, error: `На складе ${round2(stock)} ${item.unit} — выдать ${qty} нельзя` };
  const day = dayOr(body.day, today);
  if (day > today) return { status: 422, error: 'Расход будущим днём не принимается' };
  const id = randomUUID();
  const cost = avgCostOf(db, item.id);
  db.prepare(`INSERT INTO parts_moves(id,item_id,kind,qty,unit_cost_net,order_id,vehicle_id,day,note,created_by,created_by_name)
    VALUES(?,?,'issue',?,?,?,?,?,?,?,?)`).run(id, item.id, round2(qty), cost, order.id, order.vehicle_id, day,
    str(body.note, 500), user?.id || null, user?.full_name || user?.username || '');
  return { status: 201, id };
}

// Инвентаризация: факт пересчёта → движение-разница. Причина обязательна.
export function addAdjust(db, body, { user, today }) {
  const item = activeItem(db, body.itemId);
  if (!item) return { status: 422, error: 'Выберите позицию склада' };
  const counted = Number(body.counted);
  if (body.counted === '' || body.counted == null || !(counted >= 0)) return { status: 422, error: 'Укажите фактический остаток (не меньше нуля)' };
  const reason = str(body.reason ?? body.note, 500);
  if (!reason) return { status: 422, error: 'Укажите причину расхождения' };
  const delta = round2(counted - stockOf(db, item.id));
  if (Math.abs(delta) < EPS) return { status: 422, error: 'Факт совпадает с учётом — движение не нужно' };
  const id = randomUUID();
  db.prepare(`INSERT INTO parts_moves(id,item_id,kind,qty,day,note,created_by,created_by_name)
    VALUES(?,?,'adjust',?,?,?,?,?)`).run(id, item.id, delta, dayOr(body.day, today), reason, user?.id || null,
    user?.full_name || user?.username || '');
  return { status: 201, id, delta };
}

// Сторно движения: строка остаётся с отметкой. Отмена прихода не может
// увести остаток в минус; закрытая им заявка снова открывается.
export function cancelMove(db, moveId, { user, reason }) {
  const move = db.prepare('SELECT * FROM parts_moves WHERE id=?').get(moveId);
  if (!move) return { status: 404, error: 'Движение не найдено' };
  if (move.cancelled_at) return { status: 409, error: 'Движение уже отменено' };
  if (!str(reason)) return { status: 422, error: 'Укажите причину отмены' };
  const effect = move.kind === 'issue' ? -move.qty : move.qty;
  if (stockOf(db, move.item_id) - effect < -EPS) return { status: 409, error: 'Отмена уведёт остаток в минус — сначала отмените выдачи из этого прихода' };
  db.prepare(`UPDATE parts_moves SET cancelled_at=?, cancelled_by_name=?, cancel_reason=? WHERE id=?`)
    .run(new Date().toISOString(), user?.full_name || user?.username || '', str(reason), moveId);
  if (move.kind === 'receipt' && move.request_id) {
    db.prepare(`UPDATE parts_requests SET status='open', received_on=NULL, receipt_id=NULL WHERE id=? AND receipt_id=?`)
      .run(move.request_id, moveId);
  }
  return { status: 200, move };
}

export function addRequest(db, body, { user, today }) {
  const item = activeItem(db, body.itemId);
  if (!item) return { status: 422, error: 'Выберите позицию склада' };
  const qty = Number(body.qty);
  if (!(qty > 0)) return { status: 422, error: 'Количество в заявке — больше нуля' };
  const day = dayOr(body.day, today);
  if (day > today) return { status: 422, error: 'Дата заявки — не позже сегодняшней' };
  const id = randomUUID();
  db.prepare(`INSERT INTO parts_requests(id,item_id,qty,supplier,requested_on,note,created_by_name) VALUES(?,?,?,?,?,?,?)`)
    .run(id, item.id, round2(qty), str(body.supplier, 200) || item.supplier || '', day, str(body.note, 500),
      user?.full_name || user?.username || '');
  return { status: 201, id };
}

function movesList(db, { itemId = '', kind = '', from = '', to = '', orderId = '', limit = 300 } = {}) {
  const where = [];
  const params = [];
  if (itemId) { where.push('m.item_id=?'); params.push(itemId); }
  if (kind && MOVE_KIND_LABEL[kind]) { where.push('m.kind=?'); params.push(kind); }
  if (DAY_RE.test(from)) { where.push('m.day>=?'); params.push(from); }
  if (DAY_RE.test(to)) { where.push('m.day<=?'); params.push(to); }
  if (orderId) { where.push('m.order_id=?'); params.push(orderId); }
  return db.prepare(`SELECT m.*, i.name item_name, i.code item_code, i.unit, v.plate, r.purpose order_purpose, r.status order_status
    FROM parts_moves m JOIN parts_items i ON i.id=m.item_id
    LEFT JOIN vehicles v ON v.id=m.vehicle_id LEFT JOIN repair_orders r ON r.id=m.order_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY m.day DESC, m.created_at DESC LIMIT ?`).all(...params, limit)
    .map(row => ({ ...row, cost: row.kind === 'issue' && row.unit_cost_net != null ? round2(row.qty * row.unit_cost_net)
      : row.kind === 'receipt' && row.price != null ? round2(row.qty * row.price) : null }));
}

const openOrders = db => db.prepare(`SELECT r.id, r.status, r.purpose, r.complaint, r.arrived_at, v.plate
  FROM repair_orders r JOIN vehicles v ON v.id=r.vehicle_id
  WHERE r.status IN (${ISSUE_ORDER_STATUSES.map(() => '?').join(',')}) ORDER BY v.plate`).all(...ISSUE_ORDER_STATUSES);

// ── Маршруты /api/parts* ──
export async function partsApi(ctx) {
  const { db, request, response, url, pathname, user, json, errorJson, readJson, audit, requestIp, settingsObject } = ctx;
  if (!(pathname === '/api/parts' || pathname.startsWith('/api/parts/'))) return false;
  if (!user) { errorJson(response, 401, 'Требуется вход'); return true; }
  const rights = partsRights(ctx);
  if (!rights.read) { errorJson(response, 403, 'Склад запчастей — для ТОиР и руководителя'); return true; }
  const method = request.method;
  const ip = requestIp(request);
  const settings = settingsObject(db) || {};
  const today = partsToday(settings);
  const cfg = partsConfig(settings);
  const vatRate = vatRateOf(settings);
  const flags = { canWrite: rights.write, canSettings: rights.settings, money: rights.money };
  const send = (status, body) => json(response, status, rights.money ? body : stripPartsMoney(body));
  const needWrite = () => {
    if (rights.write) return true;
    errorJson(response, 403, 'Склад ведут ТОиР (право fleet:write)');
    return false;
  };
  const reply = (result, after) => {
    if (result.error) { errorJson(response, result.status, result.error); return true; }
    after?.(result);
    json(response, result.status, { ok: true, id: result.id, ...(result.delta !== undefined ? { delta: result.delta } : {}) });
    return true;
  };
  const actor = { user, today };
  const rest = pathname === '/api/parts' ? '' : pathname.slice('/api/parts/'.length);

  if ((rest === '' || rest === 'summary') && method === 'GET') {
    send(200, { ...flags, ...partsStock(db, { settings, today }) });
    return true;
  }
  if (rest === 'to-buy' && method === 'GET') {
    const data = partsStock(db, { settings, today });
    send(200, { ...flags, today, cfg: data.cfg, items: data.items.filter(item => item.toBuy > 0), totals: data.totals });
    return true;
  }
  if (rest === 'norms' && method === 'GET') {
    send(200, { ...flags, cfg, defaults: PARTS_DEFAULTS, report: partsNormsReport(db, { settings, today }) });
    return true;
  }
  if (rest === 'settings' && method === 'PUT') {
    if (!rights.settings) { errorJson(response, 403, 'Цели склада задаёт руководитель (право settings:write)'); return true; }
    const body = await readJson(request) || {};
    const next = {};
    for (const key of ['windowDays', 'minLeadSamples', 'leadMinDays', 'leadMaxDays', 'safetyFactor']) {
      if (body[key] === '' || body[key] == null) continue; // пусто — цель по умолчанию
      const n = Number(body[key]);
      if (!Number.isFinite(n) || n < 0) { errorJson(response, 422, `Неверное значение «${key}»`); return true; }
      next[key] = n;
    }
    if (next.windowDays !== undefined && next.windowDays < 1) { errorJson(response, 422, 'Окно расхода — не меньше 1 суток'); return true; }
    if (next.minLeadSamples !== undefined && next.minLeadSamples < 1) { errorJson(response, 422, 'Минимум фактов — не меньше 1'); return true; }
    const lo = next.leadMinDays ?? PARTS_DEFAULTS.leadMinDays;
    const hi = next.leadMaxDays ?? PARTS_DEFAULTS.leadMaxDays;
    if (hi < lo || hi === 0) { errorJson(response, 422, 'Коридор срока поставки задан неверно'); return true; }
    next.expenseOnIssue = body.expenseOnIssue === true;
    const before = settings.parts || {};
    db.prepare(`INSERT INTO settings(key,value_json,updated_by,updated_at) VALUES('parts',?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_by=excluded.updated_by, updated_at=CURRENT_TIMESTAMP`)
      .run(JSON.stringify(next), user.id);
    audit(db, user, 'update', 'settings', 'parts', { before, after: next }, ip);
    json(response, 200, { ok: true, cfg: partsConfig({ parts: next }) });
    return true;
  }

  // Номенклатура
  if (rest === 'items' && method === 'POST') {
    if (!needWrite()) return true;
    const item = itemFromBody(await readJson(request) || {});
    const error = itemError(item);
    if (error) { errorJson(response, 422, error); return true; }
    const duplicate = item.code && db.prepare(`SELECT name FROM parts_items WHERE archived_at IS NULL AND lower(code)=lower(?)`).get(item.code);
    if (duplicate) { errorJson(response, 409, `Артикул уже есть у позиции «${duplicate.name}»`); return true; }
    const id = randomUUID();
    db.prepare(`INSERT INTO parts_items(id,code,name,unit,category,supplier,note,manual_min,lead_days_manual,updated_by_name)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id, item.code, item.name, item.unit, item.category, item.supplier, item.note,
      item.manual_min, item.lead_days_manual, user.full_name || user.username || '');
    audit(db, user, 'create', 'parts_item', id, item, ip);
    json(response, 201, { id });
    return true;
  }
  let match = rest.match(/^items\/([^/]+)$/);
  if (match) {
    const id = decodeURIComponent(match[1]);
    const current = db.prepare('SELECT * FROM parts_items WHERE id=?').get(id);
    if (!current) { errorJson(response, 404, 'Позиция не найдена'); return true; }
    if (method === 'GET') {
      const stock = partsStock(db, { settings, today, includeArchived: true }).items.find(item => item.id === id);
      send(200, { ...flags, item: stock, moves: movesList(db, { itemId: id, limit: 100 }),
        requests: db.prepare(`SELECT * FROM parts_requests WHERE item_id=? ORDER BY requested_on DESC, created_at DESC LIMIT 50`).all(id) });
      return true;
    }
    if (method === 'PATCH') {
      if (!needWrite()) return true;
      const body = await readJson(request) || {};
      if (body.archived === true || body.archived === false) {
        db.prepare(`UPDATE parts_items SET archived_at=?, updated_at=CURRENT_TIMESTAMP, updated_by_name=? WHERE id=?`)
          .run(body.archived ? new Date().toISOString() : null, user.full_name || user.username || '', id);
        audit(db, user, body.archived ? 'archive' : 'restore', 'parts_item', id, {}, ip);
        json(response, 200, { ok: true });
        return true;
      }
      const item = itemFromBody(body, current);
      const error = itemError(item);
      if (error) { errorJson(response, 422, error); return true; }
      db.prepare(`UPDATE parts_items SET code=?,name=?,unit=?,category=?,supplier=?,note=?,manual_min=?,lead_days_manual=?,
        updated_at=CURRENT_TIMESTAMP, updated_by_name=? WHERE id=?`).run(item.code, item.name, item.unit, item.category,
        item.supplier, item.note, item.manual_min, item.lead_days_manual, user.full_name || user.username || '', id);
      audit(db, user, 'update', 'parts_item', id, { before: { ...current }, after: item }, ip);
      json(response, 200, { ok: true });
      return true;
    }
  }

  // Движения
  if (rest === 'moves' && method === 'GET') {
    const q = name => str(url.searchParams.get(name), 60);
    send(200, { ...flags, today, kinds: MOVE_KIND_LABEL,
      moves: movesList(db, { itemId: q('item'), kind: q('kind'), from: q('from'), to: q('to'), orderId: q('order') }) });
    return true;
  }
  if (rest === 'receipts' && method === 'POST') {
    if (!needWrite()) return true;
    const body = await readJson(request) || {};
    return reply(addReceipt(db, body, { ...actor, vatRate, withMoney: rights.money }),
      result => audit(db, user, 'receipt', 'parts_move', result.id, body, ip));
  }
  if (rest === 'issues' && method === 'POST') {
    if (!needWrite()) return true;
    const body = await readJson(request) || {};
    return reply(addIssue(db, body, actor), result => {
      audit(db, user, 'issue', 'parts_move', result.id, body, ip);
      // Сбой хука не отменяет выдачу: журнал затрат догоняется повтором (отпечаток).
      if (cfg.expenseOnIssue) {
        try { partsIssueExpense(db, result.id, { userId: user.id }); } catch (error) { console.error('склад → затраты:', error.message); }
      }
    });
  }
  if (rest === 'adjust' && method === 'POST') {
    if (!needWrite()) return true;
    const body = await readJson(request) || {};
    return reply(addAdjust(db, body, actor), result => audit(db, user, 'adjust', 'parts_move', result.id, { ...body, delta: result.delta }, ip));
  }
  match = rest.match(/^moves\/([^/]+)\/cancel$/);
  if (match && method === 'POST') {
    if (!needWrite()) return true;
    const id = decodeURIComponent(match[1]);
    const body = await readJson(request) || {};
    const result = cancelMove(db, id, { user, reason: body.reason });
    if (result.error) { errorJson(response, result.status, result.error); return true; }
    if (result.move.kind === 'issue') partsIssueExpenseRemove(db, id);
    audit(db, user, 'cancel', 'parts_move', id, { reason: str(body.reason), kind: result.move.kind }, ip);
    json(response, 200, { ok: true });
    return true;
  }

  // Заявки поставщику (факт срока поставки)
  if (rest === 'requests' && method === 'GET') {
    const all = url.searchParams.get('all') === '1';
    send(200, { ...flags, today, requests: db.prepare(`SELECT r.*, i.name item_name, i.code item_code, i.unit
      FROM parts_requests r JOIN parts_items i ON i.id=r.item_id
      ${all ? '' : `WHERE r.status='open' OR r.requested_on >= ?`}
      ORDER BY CASE r.status WHEN 'open' THEN 0 ELSE 1 END, r.requested_on DESC LIMIT 300`).all(...(all ? [] : [addDays(today, -cfg.windowDays)]))
      .map(row => ({ ...row, waitDays: row.status === 'open' ? daysBetween(row.requested_on, today)
        : row.received_on ? daysBetween(row.requested_on, row.received_on) : null })) });
    return true;
  }
  if (rest === 'requests' && method === 'POST') {
    if (!needWrite()) return true;
    const body = await readJson(request) || {};
    return reply(addRequest(db, body, actor), result => audit(db, user, 'create', 'parts_request', result.id, body, ip));
  }
  match = rest.match(/^requests\/([^/]+)$/);
  if (match && method === 'PATCH') {
    if (!needWrite()) return true;
    const id = decodeURIComponent(match[1]);
    const current = db.prepare('SELECT * FROM parts_requests WHERE id=?').get(id);
    if (!current) { errorJson(response, 404, 'Заявка не найдена'); return true; }
    const body = await readJson(request) || {};
    if (body.action !== 'cancel') { errorJson(response, 422, 'Заявку можно только отменить; закрывает её приход'); return true; }
    if (current.status !== 'open') { errorJson(response, 409, 'Заявка уже закрыта'); return true; }
    db.prepare(`UPDATE parts_requests SET status='cancelled' WHERE id=?`).run(id);
    audit(db, user, 'cancel', 'parts_request', id, {}, ip);
    json(response, 200, { ok: true });
    return true;
  }

  // Наряды Ремзоны для выдачи и запчасти наряда
  if (rest === 'orders' && method === 'GET') {
    send(200, { ...flags, orders: openOrders(db) });
    return true;
  }
  match = rest.match(/^orders\/([^/]+)$/);
  if (match && method === 'GET') {
    const orderId = decodeURIComponent(match[1]);
    const parts = partsForOrder(db, orderId);
    send(200, { ...flags, parts, cost: parts.some(row => row.cost == null) ? null
      : round2(parts.reduce((sum, row) => sum + row.cost, 0)) });
    return true;
  }

  errorJson(response, 404, 'Маршрут склада не найден');
  return true;
}
