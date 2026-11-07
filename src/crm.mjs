// CRM: деньги клиента замкнуты (решение руководителя «CRM делаем всю», 07.11.2026).
// Договоры и тарифы клиента → срок оплаты каждого выгруженного рейса →
// дебиторка (свод по клиенту и реестр для бухгалтерии) + воронка новых
// клиентов («Продажи в обновлённом формате»).
//
// Живые нормативы (CLAUDE.md): ни одной зашитой бизнес-константы.
// Отсрочка — только из договора клиента (crm_contracts), фолбэк — поле
// «Отсрочка» в карточке клиента (customer_profiles.payment_days, его уже
// ведут продажи). Нет ни того, ни другого — срок оплаты НЕИЗВЕСТЕН, рейс
// честно помечается «нет договора», константа не подставляется.
// Деньги — канон без НДС (src/money.mjs: calcSettings + tripNet).
import { randomUUID } from 'node:crypto';
import { calcSettings, doneDayOf, normCustomer, tripNet } from './money.mjs';

export const LEAD_STAGES = ['new', 'contact', 'offer', 'negotiation', 'won', 'lost'];
export const LEAD_STAGE_LABEL = { new: 'Новый', contact: 'Контакт', offer: 'Предложение',
  negotiation: 'Переговоры', won: 'Клиент', lost: 'Отказ' };
// Статусы «выгружен/закрыт, но не оплачен» — рейс ждёт денег клиента.
export const RECEIVABLE_STATUSES = ['unloaded', 'done'];

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

export function migrateCrm(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS crm_contracts (
    id TEXT PRIMARY KEY, customer_name TEXT NOT NULL, number TEXT NOT NULL DEFAULT '',
    signed_on TEXT, valid_to TEXT,
    payment_days INTEGER CHECK(payment_days IS NULL OR payment_days >= 0),
    demurrage_note TEXT NOT NULL DEFAULT '', tariff_note TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '', updated_by TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_crm_contracts_customer ON crm_contracts(customer_name)`);
  db.exec(`CREATE TABLE IF NOT EXISTS crm_leads (
    id TEXT PRIMARY KEY, company TEXT NOT NULL, contact TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '',
    stage TEXT NOT NULL DEFAULT 'new' CHECK(stage IN ('new','contact','offer','negotiation','won','lost')),
    next_step TEXT NOT NULL DEFAULT '', next_at TEXT, lost_reason TEXT NOT NULL DEFAULT '',
    amount_estimate REAL, owner_name TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    won_customer_name TEXT NOT NULL DEFAULT '',
    CHECK(stage <> 'lost' OR length(trim(lost_reason)) > 0))`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_crm_leads_stage ON crm_leads(stage)`);
}

// ── Даты ──
export const addDays = (day, days) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + Number(days) * DAY_MS).toISOString().slice(0, 10);
export const daysBetween = (fromDay, toDay) =>
  Math.round((Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) / DAY_MS);

// «Сегодня» в часовом поясе планирования (Настройки → Общие → timezone).
export function todayIn(timeZone, nowMs = Date.now()) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timeZone || undefined,
      year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(nowMs));
  } catch { return new Date(nowMs).toISOString().slice(0, 10); }
}

// ── Условия оплаты клиента ──
// Договор, действующий на день выгрузки: подписан не позже и не истёк.
// Если на этот день ни один не действует — последний по дате подписания
// (помечается «вне срока договора», условия те же — других мы не знаем).
export function contractFor(contracts, day) {
  if (!contracts?.length) return null;
  const sorted = [...contracts].sort((a, b) => String(b.signed_on || '').localeCompare(String(a.signed_on || ''))
    || String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
  const active = sorted.find(item => (!item.signed_on || item.signed_on <= day) && (!item.valid_to || item.valid_to >= day));
  return active ? { ...active, outOfTerm: false } : { ...sorted[0], outOfTerm: true };
}

// Справочник условий: норм. имя клиента → { contracts, profileDays }.
export function paymentTerms(db) {
  const terms = new Map();
  const slot = name => {
    const key = normCustomer(name);
    if (!terms.has(key)) terms.set(key, { contracts: [], profileDays: null });
    return terms.get(key);
  };
  for (const row of db.prepare('SELECT * FROM crm_contracts').all()) slot(row.customer_name).contracts.push({ ...row });
  try {
    for (const row of db.prepare('SELECT customer_name, payment_days FROM customer_profiles WHERE payment_days IS NOT NULL').all()) {
      slot(row.customer_name).profileDays = Number(row.payment_days);
    }
  } catch { /* таблицы профилей нет — только договоры */ }
  return terms;
}

// Срок оплаты рейса: день выгрузки + отсрочка договора (или карточки).
// Нет условий — dueDay=null, source='none' («нет договора»).
export function dueOf(trip, terms, today) {
  const day = doneDayOf(trip);
  const term = terms.get(normCustomer(trip.customer_name));
  const contract = contractFor(term?.contracts, day);
  let paymentDays = null;
  let source = 'none';
  if (contract && contract.payment_days != null) { paymentDays = Number(contract.payment_days); source = 'contract'; }
  else if (term?.profileDays != null) { paymentDays = term.profileDays; source = 'profile'; }
  const dueDay = paymentDays != null && DAY_RE.test(day) ? addDays(day, paymentDays) : null;
  const overdueDays = dueDay && dueDay < today ? daysBetween(dueDay, today) : 0;
  return { unloadDay: day, paymentDays, source, contractId: contract?.id || null,
    contractNumber: contract?.number || '', contractOutOfTerm: Boolean(contract?.outOfTerm),
    dueDay, overdue: overdueDays > 0, overdueDays, ageDays: DAY_RE.test(day) ? daysBetween(day, today) : null };
}

// Реестр рейсов к оплате. Сортировка — по сроку (просроченные первыми),
// рейсы без договора — в конце, старые выше.
export function receivableRows(db, { today, customer = '', from = '', calc = calcSettings(db) } = {}) {
  const terms = paymentTerms(db);
  const params = [...RECEIVABLE_STATUSES];
  let where = `t.status IN (${RECEIVABLE_STATUSES.map(() => '?').join(',')}) AND t.revenue_vat > 0`;
  if (from && DAY_RE.test(from)) { where += ` AND substr(COALESCE(t.unloaded_at, t.ends_at),1,10) >= ?`; params.push(from); }
  const rows = db.prepare(`SELECT t.id, t.order_no, t.customer_name, t.status, t.revenue_vat, t.cash,
      t.unloaded_at, t.ends_at, t.starts_at, t.from_point, t.to_point,
      v.plate, zf.name AS from_zone, zt.name AS to_zone
    FROM trips t LEFT JOIN vehicles v ON v.id=t.vehicle_id
      LEFT JOIN zones zf ON zf.id=t.from_zone_id LEFT JOIN zones zt ON zt.id=t.to_zone_id
    WHERE ${where}`).all(...params);
  const wanted = customer ? normCustomer(customer) : '';
  return rows.filter(row => !wanted || normCustomer(row.customer_name) === wanted).map(row => ({
    id: row.id, orderNo: row.order_no || '', customer: row.customer_name, status: row.status,
    plate: row.plate || '', route: `${row.from_point || row.from_zone || ''} → ${row.to_point || row.to_zone || ''}`,
    revenueVat: Number(row.revenue_vat || 0), net: Math.round(tripNet(row, calc)),
    ...dueOf(row, terms, today)
  })).sort((a, b) => (a.dueDay ? 0 : 1) - (b.dueDay ? 0 : 1)
    || String(a.dueDay || a.unloadDay).localeCompare(String(b.dueDay || b.unloadDay)));
}

// Свод дебиторки по клиенту: к оплате, просрочено, без договора, самый старый долг.
export function receivablesByCustomer(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = normCustomer(row.customer);
    if (!map.has(key)) {
      map.set(key, { customer: row.customer, count: 0, net: 0, revenueVat: 0, overdueCount: 0, overdueNet: 0,
        noTermsCount: 0, noTermsNet: 0, oldestDay: null, maxOverdueDays: 0, nextDueDay: null });
    }
    const item = map.get(key);
    item.count += 1; item.net += row.net; item.revenueVat += row.revenueVat;
    if (row.overdue) { item.overdueCount += 1; item.overdueNet += row.net; }
    if (!row.dueDay) { item.noTermsCount += 1; item.noTermsNet += row.net; }
    if (row.unloadDay && (!item.oldestDay || row.unloadDay < item.oldestDay)) item.oldestDay = row.unloadDay;
    item.maxOverdueDays = Math.max(item.maxOverdueDays, row.overdueDays);
    if (row.dueDay && !row.overdue && (!item.nextDueDay || row.dueDay < item.nextDueDay)) item.nextDueDay = row.dueDay;
  }
  return [...map.values()].sort((a, b) => b.overdueNet - a.overdueNet || b.net - a.net);
}

export function receivablesTotals(rows) {
  const sum = list => list.reduce((acc, row) => acc + row.net, 0);
  const overdue = rows.filter(row => row.overdue);
  const noTerms = rows.filter(row => !row.dueDay);
  const oldest = rows.reduce((acc, row) => row.unloadDay && (!acc || row.unloadDay < acc) ? row.unloadDay : acc, null);
  return { count: rows.length, net: sum(rows), overdueCount: overdue.length, overdueNet: sum(overdue),
    noTermsCount: noTerms.length, noTermsNet: sum(noTerms), oldestDay: oldest,
    maxOverdueDays: rows.reduce((acc, row) => Math.max(acc, row.overdueDays), 0) };
}

// ── Воронка ──
// Проверка перехода: «Отказ» без причины не принимается (причины — сырьё
// для разбора, как отклонения рейсов). Возвращает текст ошибки или ''.
export function leadError(lead) {
  if (!String(lead.company || '').trim()) return 'Укажите компанию';
  if (!LEAD_STAGES.includes(lead.stage)) return 'Неизвестная стадия воронки';
  if (lead.stage === 'lost' && !String(lead.lost_reason || '').trim()) return 'Для отказа укажите причину';
  if (lead.next_at && Number.isNaN(Date.parse(lead.next_at))) return 'Неверная дата следующего шага';
  if (lead.amount_estimate != null && !(Number(lead.amount_estimate) >= 0)) return 'Оценка суммы — неотрицательное число';
  return '';
}

// Показатели воронки — только из факта: конверсия считается, когда есть
// закрытые сделки; причины отказов — как их записали люди.
export function leadStats(leads, nowIso = new Date().toISOString()) {
  const byStage = Object.fromEntries(LEAD_STAGES.map(stage => [stage, { count: 0, amount: 0 }]));
  const reasons = new Map();
  let overdueSteps = 0;
  for (const lead of leads) {
    const slot = byStage[lead.stage];
    if (slot) { slot.count += 1; slot.amount += Number(lead.amount_estimate || 0); }
    if (lead.stage === 'lost') {
      const reason = String(lead.lost_reason || '').trim();
      reasons.set(reason, (reasons.get(reason) || 0) + 1);
    }
    if (!['won', 'lost'].includes(lead.stage) && lead.next_at && String(lead.next_at).slice(0, 10) < String(nowIso).slice(0, 10)) overdueSteps += 1;
  }
  const closed = byStage.won.count + byStage.lost.count;
  const open = leads.length - closed;
  return { byStage, open, closed, overdueSteps,
    winRate: closed ? byStage.won.count / closed : null,
    lostReasons: [...reasons].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count) };
}

// ── Карточка/список клиентов ──
function customerNames(db) {
  const seen = new Map();
  const add = name => {
    const text = String(name || '').trim();
    const key = normCustomer(text);
    if (key && !seen.has(key)) seen.set(key, text);
  };
  for (const row of db.prepare('SELECT DISTINCT name FROM customers').all()) add(row.name);
  for (const row of db.prepare(`SELECT DISTINCT customer_name FROM trips WHERE customer_name<>''`).all()) add(row.customer_name);
  for (const row of db.prepare('SELECT DISTINCT customer_name FROM crm_contracts').all()) add(row.customer_name);
  return seen;
}

function tableExists(db, name) {
  return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name));
}

export function crmSummary(db, { today, calc = calcSettings(db) } = {}) {
  const names = customerNames(db);
  const rows = receivableRows(db, { today, calc });
  const debt = new Map(receivablesByCustomer(rows).map(item => [normCustomer(item.customer), item]));
  const terms = paymentTerms(db);
  const trips = new Map();
  for (const row of db.prepare(`SELECT customer_name, COUNT(*) AS n, MAX(starts_at) AS last_at
      FROM trips WHERE customer_name<>'' AND status<>'rejected' GROUP BY customer_name`).all()) {
    const key = normCustomer(row.customer_name);
    const prev = trips.get(key) || { n: 0, last: '' };
    trips.set(key, { n: prev.n + row.n, last: String(row.last_at || '') > prev.last ? String(row.last_at) : prev.last });
  }
  const claims = new Map();
  if (tableExists(db, 'demurrage_claims')) {
    for (const row of db.prepare(`SELECT customer_name, status, COUNT(*) AS n, SUM(amount) AS s
        FROM demurrage_claims WHERE status IN ('new','billed') GROUP BY customer_name, status`).all()) {
      const key = normCustomer(row.customer_name);
      const slot = claims.get(key) || { newCount: 0, newSum: 0, billedCount: 0, billedSum: 0 };
      if (row.status === 'new') { slot.newCount += row.n; slot.newSum += Number(row.s || 0); }
      else { slot.billedCount += row.n; slot.billedSum += Number(row.s || 0); }
      claims.set(key, slot);
    }
  }
  const contacts = new Map();
  for (const row of db.prepare('SELECT customer_name, COUNT(*) AS n FROM customer_contacts GROUP BY customer_name').all()) {
    const key = normCustomer(row.customer_name);
    contacts.set(key, (contacts.get(key) || 0) + row.n);
  }
  const customers = [...names].map(([key, name]) => {
    const term = terms.get(key);
    const contract = contractFor(term?.contracts, today);
    return { name, trips: trips.get(key)?.n || 0, lastTripAt: trips.get(key)?.last || null,
      contract: contract ? { id: contract.id, number: contract.number, validTo: contract.valid_to,
        paymentDays: contract.payment_days, outOfTerm: contract.outOfTerm } : null,
      profileDays: term?.profileDays ?? null, contracts: term?.contracts.length || 0,
      debt: debt.get(key) || null, claims: claims.get(key) || null, contacts: contacts.get(key) || 0 };
  }).sort((a, b) => (b.debt?.overdueNet || 0) - (a.debt?.overdueNet || 0) || (b.debt?.net || 0) - (a.debt?.net || 0)
    || String(b.lastTripAt || '').localeCompare(String(a.lastTripAt || '')));
  const withTrips = customers.filter(item => item.trips);
  return { today, totals: receivablesTotals(rows), customers,
    coverage: { withTrips: withTrips.length, withContract: withTrips.filter(item => item.contract).length,
      withTerms: withTrips.filter(item => item.contract?.paymentDays != null || item.profileDays != null).length } };
}

export function crmCustomer(db, name, { today, calc = calcSettings(db), recent = 10 } = {}) {
  const key = normCustomer(name);
  const contracts = db.prepare('SELECT * FROM crm_contracts ORDER BY signed_on DESC, updated_at DESC').all()
    .filter(row => normCustomer(row.customer_name) === key);
  const receivables = receivableRows(db, { today, customer: name, calc });
  const lastTrips = db.prepare(`SELECT t.id, t.order_no, t.customer_name, t.status, t.starts_at, t.ends_at, t.unloaded_at,
      t.revenue_vat, t.cash, t.from_point, t.to_point, v.plate
    FROM trips t LEFT JOIN vehicles v ON v.id=t.vehicle_id
    WHERE t.customer_name<>'' AND t.status<>'rejected' ORDER BY t.starts_at DESC`).all()
    .filter(row => normCustomer(row.customer_name) === key).slice(0, recent)
    .map(row => ({ id: row.id, orderNo: row.order_no || '', status: row.status, startsAt: row.starts_at,
      unloadDay: doneDayOf(row), plate: row.plate || '', route: `${row.from_point || ''} → ${row.to_point || ''}`,
      net: Math.round(tripNet(row, calc)) }));
  // Фильтр по клиенту — в JS: lower() в SQLite не знает кириллицу.
  const claimRows = tableExists(db, 'demurrage_claims')
    ? db.prepare(`SELECT id, trip_id, customer_name, order_no, stop_kind, point, idle_hours, paid_hours, amount, status, created_day
        FROM demurrage_claims ORDER BY created_day DESC`).all().filter(row => normCustomer(row.customer_name) === key)
    : [];
  const contacts = db.prepare('SELECT id, customer_name, full_name, position, phone, email, note FROM customer_contacts ORDER BY full_name')
    .all().filter(row => normCustomer(row.customer_name) === key);
  let profile = null;
  try {
    profile = db.prepare('SELECT * FROM customer_profiles').all().find(row => normCustomer(row.customer_name) === key) || null;
  } catch { /* нет таблицы профилей */ }
  const sumBy = status => claimRows.filter(row => row.status === status).reduce((acc, row) => acc + Number(row.amount || 0), 0);
  return { name, today, contracts, contract: contractFor(contracts, today), profileDays: profile?.payment_days ?? null,
    receivables, totals: receivablesTotals(receivables), lastTrips,
    claims: { rows: claimRows.filter(row => row.status !== 'cancelled'),
      newSum: sumBy('new'), billedSum: sumBy('billed') },
    contacts };
}

// ── Нормализация входа ──
const str = (value, max = 500) => String(value ?? '').trim().slice(0, max);
const dayOrNull = value => {
  const text = str(value, 10);
  return DAY_RE.test(text) ? text : null;
};
const intOrNull = value => value === '' || value == null ? null : Number.isFinite(Number(value)) ? Math.round(Number(value)) : NaN;
const numOrNull = value => value === '' || value == null ? null : Number(value);

export function contractFromBody(body, current = {}) {
  const pick = (camel, snake) => body[camel] !== undefined ? body[camel] : body[snake] !== undefined ? body[snake] : current[snake];
  return {
    customer_name: str(pick('customerName', 'customer_name'), 200),
    number: str(pick('number', 'number'), 100),
    signed_on: dayOrNull(pick('signedOn', 'signed_on')),
    valid_to: dayOrNull(pick('validTo', 'valid_to')),
    payment_days: intOrNull(pick('paymentDays', 'payment_days')),
    demurrage_note: str(pick('demurrageNote', 'demurrage_note'), 2000),
    tariff_note: str(pick('tariffNote', 'tariff_note'), 2000),
    note: str(pick('note', 'note'), 2000)
  };
}

export function contractError(contract) {
  if (!contract.customer_name) return 'Укажите клиента';
  if (Number.isNaN(contract.payment_days) || (contract.payment_days != null && contract.payment_days < 0)) {
    return 'Отсрочка оплаты — целое число дней не меньше нуля';
  }
  if (contract.signed_on && contract.valid_to && contract.valid_to < contract.signed_on) {
    return 'Срок действия раньше даты подписания';
  }
  return '';
}

export function leadFromBody(body, current = {}) {
  const pick = (camel, snake) => body[camel] !== undefined ? body[camel] : body[snake] !== undefined ? body[snake] : current[snake];
  const nextAt = str(pick('nextAt', 'next_at'), 40);
  return {
    company: str(pick('company', 'company'), 200),
    contact: str(pick('contact', 'contact'), 200),
    phone: str(pick('phone', 'phone'), 60),
    email: str(pick('email', 'email'), 200),
    source: str(pick('source', 'source'), 200),
    stage: str(pick('stage', 'stage') || 'new', 20),
    next_step: str(pick('nextStep', 'next_step'), 500),
    next_at: nextAt || null,
    lost_reason: str(pick('lostReason', 'lost_reason'), 500),
    amount_estimate: numOrNull(pick('amountEstimate', 'amount_estimate')),
    owner_name: str(pick('ownerName', 'owner_name'), 200),
    won_customer_name: str(pick('wonCustomerName', 'won_customer_name'), 200)
  };
}

// ── Доступ ──
export function crmRights({ user, access, hasPermission }) {
  if (!user) return { read: false, write: false, pay: false, money: false };
  const views = access?.views || [];
  const legacy = !access || access.legacy;
  const read = legacy
    ? hasPermission(user, 'orders:write') || hasPermission(user, 'payments:write') || hasPermission(user, 'reports:read')
    : views.includes('crm') || views.includes('payments');
  const write = hasPermission(user, 'orders:write') || hasPermission(user, 'users:write');
  const pay = hasPermission(user, 'payments:write');
  return { read, write: read && write, pay: read && pay, money: (access?.money ?? 'full') !== 'none' };
}

// Без денег: суммы вырезаются целиком (не нули — чтобы не путать с «долга нет»).
const MONEY_KEYS = new Set(['net', 'revenueVat', 'overdueNet', 'noTermsNet', 'amount', 'amount_estimate',
  'newSum', 'billedSum', 'rate']);
export function stripMoney(value) {
  if (Array.isArray(value)) return value.map(stripMoney);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([key]) => !MONEY_KEYS.has(key))
      .map(([key, item]) => [key, stripMoney(item)]));
  }
  return value;
}

// ── Маршруты /api/crm/* ──
export async function crmApi(ctx) {
  const { db, request, response, url, pathname, user, json, errorJson, readJson, audit, requestIp, settingsObject } = ctx;
  if (!pathname.startsWith('/api/crm/')) return false;
  if (!user) { errorJson(response, 401, 'Требуется вход'); return true; }
  const rights = crmRights(ctx);
  if (!rights.read) { errorJson(response, 403, 'Нет доступа к CRM'); return true; }
  const method = request.method;
  const ip = requestIp(request);
  const today = todayIn(settingsObject(db)?.general?.timezone);
  const send = (status, body) => json(response, status, rights.money ? body : stripMoney(body));
  const flags = { canWrite: rights.write, canPay: rights.pay, money: rights.money };
  const needWrite = () => {
    if (rights.write) return true;
    errorJson(response, 403, 'Изменять CRM может планирование или администратор');
    return false;
  };

  if (pathname === '/api/crm/summary' && method === 'GET') {
    send(200, { ...flags, ...crmSummary(db, { today }) });
    return true;
  }
  if (pathname === '/api/crm/customer' && method === 'GET') {
    const name = str(url.searchParams.get('name'), 200);
    if (!name) { errorJson(response, 400, 'Не указан клиент'); return true; }
    send(200, { ...flags, ...crmCustomer(db, name, { today }) });
    return true;
  }
  if (pathname === '/api/crm/receivables' && method === 'GET') {
    const rows = receivableRows(db, { today, customer: str(url.searchParams.get('customer'), 200),
      from: str(url.searchParams.get('from'), 10) });
    send(200, { ...flags, today, rows, totals: receivablesTotals(rows), byCustomer: receivablesByCustomer(rows) });
    return true;
  }

  // Договоры
  if (pathname === '/api/crm/contracts' && method === 'GET') {
    send(200, { ...flags, today, contracts: db.prepare('SELECT * FROM crm_contracts ORDER BY customer_name, signed_on DESC').all(),
      customers: [...customerNames(db).values()].sort((a, b) => a.localeCompare(b, 'ru')) });
    return true;
  }
  if (pathname === '/api/crm/contracts' && method === 'POST') {
    if (!needWrite()) return true;
    const contract = contractFromBody(await readJson(request));
    const error = contractError(contract);
    if (error) { errorJson(response, 422, error); return true; }
    const id = randomUUID();
    db.prepare(`INSERT INTO crm_contracts(id,customer_name,number,signed_on,valid_to,payment_days,demurrage_note,tariff_note,note,updated_by,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(id, contract.customer_name, contract.number, contract.signed_on, contract.valid_to,
      contract.payment_days, contract.demurrage_note, contract.tariff_note, contract.note, user.id, new Date().toISOString());
    audit(db, user, 'create', 'crm_contract', id, contract, ip);
    json(response, 201, { id });
    return true;
  }
  let match = pathname.match(/^\/api\/crm\/contracts\/([^/]+)$/);
  if (match && (method === 'PATCH' || method === 'DELETE')) {
    if (!needWrite()) return true;
    const id = decodeURIComponent(match[1]);
    const current = db.prepare('SELECT * FROM crm_contracts WHERE id=?').get(id);
    if (!current) { errorJson(response, 404, 'Договор не найден'); return true; }
    if (method === 'DELETE') {
      db.prepare('DELETE FROM crm_contracts WHERE id=?').run(id);
      audit(db, user, 'delete', 'crm_contract', id, { ...current }, ip);
      json(response, 200, { ok: true });
      return true;
    }
    const contract = contractFromBody(await readJson(request), current);
    const error = contractError(contract);
    if (error) { errorJson(response, 422, error); return true; }
    db.prepare(`UPDATE crm_contracts SET customer_name=?,number=?,signed_on=?,valid_to=?,payment_days=?,demurrage_note=?,
      tariff_note=?,note=?,updated_by=?,updated_at=? WHERE id=?`).run(contract.customer_name, contract.number, contract.signed_on,
      contract.valid_to, contract.payment_days, contract.demurrage_note, contract.tariff_note, contract.note, user.id,
      new Date().toISOString(), id);
    audit(db, user, 'update', 'crm_contract', id, { before: { ...current }, after: contract }, ip);
    json(response, 200, { ok: true });
    return true;
  }

  // Воронка
  if (pathname === '/api/crm/leads' && method === 'GET') {
    const leads = db.prepare('SELECT * FROM crm_leads ORDER BY updated_at DESC').all().map(row => ({ ...row }));
    send(200, { ...flags, stages: LEAD_STAGES.map(id => [id, LEAD_STAGE_LABEL[id]]), leads,
      stats: leadStats(leads), customers: [...customerNames(db).values()].sort((a, b) => a.localeCompare(b, 'ru')) });
    return true;
  }
  if (pathname === '/api/crm/leads' && method === 'POST') {
    if (!needWrite()) return true;
    const lead = leadFromBody(await readJson(request));
    if (!lead.owner_name) lead.owner_name = user.full_name || user.username || '';
    const error = leadError(lead);
    if (error) { errorJson(response, 422, error); return true; }
    const id = randomUUID();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO crm_leads(id,company,contact,phone,email,source,stage,next_step,next_at,lost_reason,amount_estimate,
      owner_name,won_customer_name,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, lead.company, lead.contact,
      lead.phone, lead.email, lead.source, lead.stage, lead.next_step, lead.next_at, lead.lost_reason, lead.amount_estimate,
      lead.owner_name, lead.won_customer_name, now, now);
    audit(db, user, 'create', 'crm_lead', id, lead, ip);
    json(response, 201, { id });
    return true;
  }
  match = pathname.match(/^\/api\/crm\/leads\/([^/]+)$/);
  if (match && method === 'PATCH') {
    if (!needWrite()) return true;
    const id = decodeURIComponent(match[1]);
    const current = db.prepare('SELECT * FROM crm_leads WHERE id=?').get(id);
    if (!current) { errorJson(response, 404, 'Лид не найден'); return true; }
    const body = await readJson(request);
    const lead = leadFromBody(body, current);
    // Вернули из отказа — прежняя причина не тянется за живым лидом.
    if (lead.stage !== 'lost' && body.lostReason === undefined && body.lost_reason === undefined) lead.lost_reason = '';
    if (lead.stage !== 'won' && body.wonCustomerName === undefined && body.won_customer_name === undefined) lead.won_customer_name = '';
    const error = leadError(lead);
    if (error) { errorJson(response, 422, error); return true; }
    db.prepare(`UPDATE crm_leads SET company=?,contact=?,phone=?,email=?,source=?,stage=?,next_step=?,next_at=?,lost_reason=?,
      amount_estimate=?,owner_name=?,won_customer_name=?,updated_at=? WHERE id=?`).run(lead.company, lead.contact, lead.phone,
      lead.email, lead.source, lead.stage, lead.next_step, lead.next_at, lead.lost_reason, lead.amount_estimate, lead.owner_name,
      lead.won_customer_name, new Date().toISOString(), id);
    audit(db, user, current.stage !== lead.stage ? `stage:${lead.stage}` : 'update', 'crm_lead', id,
      { before: { stage: current.stage }, after: lead }, ip);
    json(response, 200, { ok: true });
    return true;
  }

  errorJson(response, 404, 'Маршрут CRM не найден');
  return true;
}
