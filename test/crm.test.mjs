// CRM: договоры → срок оплаты → дебиторка; воронка; права (07.11.2026).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../src/db.mjs';
import { hasPermission } from '../src/permissions.mjs';
import { calcSettings, tripNet } from '../src/money.mjs';
import { contractFor, crmApi, crmCustomer, crmRights, crmSummary, factPaymentDays, leadError, leadStats, markTripPaid, migrateCrm,
  receivableRows, receivablesByCustomer, receivablesTotals, syncContractDays } from '../src/crm.mjs';

function freshDb(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pegas-crm-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = openDatabase(path.join(directory, 'planner.db'), {
    username: 'root-admin', password: 'Temporary-password-2026', fullName: 'Администратор'
  });
  t.after(() => db.close());
  migrateCrm(db);
  migrateCrm(db); // идемпотентно
  // Демо-рейсы сида мешают точным суммам — тест строит свои.
  db.exec('PRAGMA foreign_keys=OFF; DELETE FROM demurrage_claims; DELETE FROM trips; PRAGMA foreign_keys=ON;');
  return db;
}

function addTrip(db, { customer, status, unloadedAt = null, endsAt, revenue = 122000, cash = 0 }) {
  const vehicle = db.prepare('SELECT id FROM vehicles LIMIT 1').get().id;
  const zone = db.prepare('SELECT id FROM zones LIMIT 1').get().id;
  const id = randomUUID();
  db.prepare(`INSERT INTO trips(id,vehicle_id,customer_name,from_zone_id,to_zone_id,starts_at,ends_at,distance_km,revenue_vat,status,unloaded_at,cash)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, vehicle, customer, zone, zone, `${endsAt.slice(0, 10)}T00:00:00Z`, endsAt, 500,
    revenue, status, unloadedAt, cash);
  return id;
}
const addContract = (db, row) => db.prepare(`INSERT INTO crm_contracts(id,customer_name,number,signed_on,valid_to,payment_days)
  VALUES(?,?,?,?,?,?)`).run(randomUUID(), row.customer, row.number || '', row.signedOn || null, row.validTo || null, row.days ?? null);

const TODAY = '2026-11-07';

test('договор задаёт срок оплаты: выгрузка + отсрочка, просрочка в днях, деньги по канону', t => {
  const db = freshDb(t);
  addContract(db, { customer: 'ООО Провентус', number: '12/26', signedOn: '2026-01-01', days: 30 });
  const late = addTrip(db, { customer: 'ооо  провентус', status: 'done', unloadedAt: '2026-09-20T10:00:00Z', endsAt: '2026-09-19T10:00:00Z' });
  const fresh = addTrip(db, { customer: 'ООО Провентус', status: 'unloaded', endsAt: '2026-11-01T10:00:00Z' });
  addTrip(db, { customer: 'ООО Провентус', status: 'paid', unloadedAt: '2026-08-01T10:00:00Z', endsAt: '2026-08-01T10:00:00Z' });
  addTrip(db, { customer: 'ООО Провентус', status: 'run', endsAt: '2026-11-08T10:00:00Z' });
  const rows = receivableRows(db, { today: TODAY });
  assert.equal(rows.length, 2); // paid и run — не к оплате
  const a = rows.find(row => row.id === late);
  assert.equal(a.unloadDay, '2026-09-20'); // факт выгрузки важнее расчётной
  assert.equal(a.dueDay, '2026-10-20');
  assert.equal(a.overdue, true);
  assert.equal(a.overdueDays, 18);
  assert.equal(a.source, 'contract');
  assert.equal(a.contractNumber, '12/26');
  const calc = calcSettings(db);
  assert.equal(a.net, Math.round(tripNet({ customer_name: 'ооо  провентус', revenue_vat: 122000, cash: 0 }, calc)));
  const b = rows.find(row => row.id === fresh);
  assert.equal(b.unloadDay, '2026-11-01'); // нет факта — расчётная ends_at
  assert.equal(b.dueDay, '2026-12-01');
  assert.equal(b.overdue, false);
  assert.equal(rows[0].id, late); // реестр по сроку
  const [byCustomer] = receivablesByCustomer(rows);
  assert.equal(byCustomer.count, 2);
  assert.equal(byCustomer.overdueCount, 1);
  assert.equal(byCustomer.oldestDay, '2026-09-20');
  assert.equal(byCustomer.nextDueDay, '2026-12-01');
  assert.equal(byCustomer.maxOverdueDays, 18);
});

test('нет договора — срок неизвестен, константа не подставляется; фолбэк — отсрочка карточки', t => {
  const db = freshDb(t);
  addTrip(db, { customer: 'Мегас ООО', status: 'done', unloadedAt: '2025-01-01T10:00:00Z', endsAt: '2025-01-01T10:00:00Z' });
  let [row] = receivableRows(db, { today: TODAY });
  assert.equal(row.dueDay, null);
  assert.equal(row.paymentDays, null);
  assert.equal(row.source, 'none');
  assert.equal(row.overdue, false); // старый долг без договора не становится «просрочкой» по выдуманному сроку
  const totals = receivablesTotals([row]);
  assert.equal(totals.noTermsCount, 1);
  assert.equal(totals.overdueCount, 0);
  // Договор без отсрочки — тоже «срок неизвестен».
  addContract(db, { customer: 'Мегас ООО', number: 'б/н', days: null });
  [row] = receivableRows(db, { today: TODAY });
  assert.equal(row.dueDay, null);
  // Отсрочка из карточки клиента (customer_profiles) — фолбэк.
  db.prepare(`INSERT INTO customer_profiles(customer_name,payment_days) VALUES(?,?)`).run('МЕГАС ООО', 10);
  [row] = receivableRows(db, { today: TODAY });
  assert.equal(row.source, 'profile');
  assert.equal(row.dueDay, '2025-01-11');
  assert.equal(row.overdue, true);
  // Ноль в договоре — осознанное значение (предоплата/день в день), не пустота.
  addContract(db, { customer: 'Мегас ООО', number: '1', signedOn: '2024-01-01', days: 0 });
  [row] = receivableRows(db, { today: TODAY });
  assert.equal(row.source, 'contract');
  assert.equal(row.dueDay, '2025-01-01');
});

test('выбор договора по дате выгрузки и «вне срока»', () => {
  const contracts = [
    { id: 'old', signed_on: '2025-01-01', valid_to: '2025-12-31', payment_days: 45 },
    { id: 'new', signed_on: '2026-01-01', valid_to: '2026-06-30', payment_days: 20 }
  ];
  assert.equal(contractFor(contracts, '2025-05-01').id, 'old');
  assert.equal(contractFor(contracts, '2026-03-01').id, 'new');
  const out = contractFor(contracts, '2026-09-01');
  assert.equal(out.id, 'new');
  assert.equal(out.outOfTerm, true);
  assert.equal(contractFor([], '2026-01-01'), null);
});

test('свод CRM и карточка: покрытие договорами, претензии, контакты', t => {
  const db = freshDb(t);
  addContract(db, { customer: 'Иней', number: '7', signedOn: '2026-01-01', days: 14 });
  const trip = addTrip(db, { customer: 'Иней', status: 'unloaded', unloadedAt: '2026-10-01T10:00:00Z', endsAt: '2026-10-01T10:00:00Z' });
  addTrip(db, { customer: 'Эрманн', status: 'done', endsAt: '2026-10-05T10:00:00Z' });
  db.prepare(`INSERT INTO demurrage_claims(id,trip_id,stop_kind,customer_name,plan_at,arrived_at,amount,status,created_day)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(randomUUID(), trip, 'unload', 'Иней', '2026-10-01T08:00:00Z', '2026-10-01T08:00:00Z', 6000, 'new', '2026-10-01');
  db.prepare(`INSERT INTO customer_contacts(id,customer_name,full_name,phone) VALUES(?,?,?,?)`).run(randomUUID(), 'Иней', 'Петрова А.', '+7 900');
  const summary = crmSummary(db, { today: TODAY });
  const inei = summary.customers.find(item => item.name === 'Иней');
  assert.equal(inei.contract.number, '7');
  assert.equal(inei.debt.overdueCount, 1);
  assert.equal(inei.claims.newSum, 6000);
  assert.equal(inei.contacts, 1);
  const ermann = summary.customers.find(item => item.name === 'Эрманн');
  assert.equal(ermann.contract, null);
  assert.equal(summary.coverage.withTrips >= 2, true);
  assert.equal(summary.totals.noTermsCount, 1);
  const card = crmCustomer(db, 'ИНЕЙ', { today: TODAY });
  assert.equal(card.contract.number, '7');
  assert.equal(card.receivables.length, 1);
  assert.equal(card.lastTrips.length, 1);
  assert.equal(card.claims.newSum, 6000);
  assert.equal(card.contacts[0].full_name, 'Петрова А.');
});

test('воронка: отказ требует причину, конверсия только из закрытых', t => {
  assert.equal(leadError({ company: 'Альфа', stage: 'lost', lost_reason: '  ' }), 'Для отказа укажите причину');
  assert.equal(leadError({ company: 'Альфа', stage: 'lost', lost_reason: 'дорого' }), '');
  assert.equal(leadError({ company: '', stage: 'new' }), 'Укажите компанию');
  assert.equal(leadError({ company: 'Альфа', stage: 'нечто' }), 'Неизвестная стадия воронки');
  const empty = leadStats([{ stage: 'new' }, { stage: 'offer', next_at: '2026-11-01' }], '2026-11-07T09:00:00Z');
  assert.equal(empty.winRate, null); // нет закрытых — нет конверсии, не 0%
  assert.equal(empty.overdueSteps, 1);
  const stats = leadStats([{ stage: 'won' }, { stage: 'lost', lost_reason: 'дорого' }, { stage: 'lost', lost_reason: 'дорого' },
    { stage: 'contact', next_at: '2026-11-07' }], '2026-11-07T09:00:00Z');
  assert.equal(stats.winRate, 1 / 3);
  assert.deepEqual(stats.lostReasons, [{ reason: 'дорого', count: 2 }]);
  assert.equal(stats.overdueSteps, 0); // шаг на сегодня ещё не просрочен
  // Таблица сама не примет отказ без причины.
  const db = freshDb(t);
  assert.throws(() => db.prepare(`INSERT INTO crm_leads(id,company,stage) VALUES('x','Альфа','lost')`).run());
});

// Обвязка маршрутов: ctx как у сервера, ответ пишется в объект.
function makeCtx(db, user, access, { method = 'GET', pathname, search = '', body = {}, debtOn = true } = {}) {
  const out = { status: 0, body: null, audits: [] };
  const ctx = {
    db, user, access, pathname, url: new URL(`http://x${pathname}${search}`),
    request: { method }, response: {},
    json: (_r, status, obj) => { out.status = status; out.body = obj; },
    errorJson: (_r, status, msg) => { out.status = status; out.body = { error: msg }; },
    readJson: async () => body,
    audit: (...args) => out.audits.push(args),
    requestIp: () => '127.0.0.1', settingsObject: () => ({ general: { timezone: 'Europe/Moscow' }, calculation: { crmReceivablesOn: debtOn } }), hasPermission
  };
  return { ctx, out };
}
const legacy = { legacy: true, views: null, money: 'full', scope: { all: true, depts: [] } };
const userOf = role => ({ id: `u-${role}`, username: role, full_name: `Тест ${role}`, active: 1, role, roles: JSON.stringify([role]) });

test('права: чтение, запись, оплата, деньги', async t => {
  const db = freshDb(t);
  addTrip(db, { customer: 'Иней', status: 'unloaded', endsAt: '2026-10-01T10:00:00Z' });
  // Прежняя модель: продажи — читают и пишут; бухгалтерия — читает и платит; диспетчер — нет.
  assert.deepEqual(crmRights({ user: userOf('sales'), access: legacy, hasPermission }),
    { read: true, write: true, pay: false, money: true });
  assert.deepEqual(crmRights({ user: userOf('accountant'), access: legacy, hasPermission }),
    { read: true, write: false, pay: true, money: true });
  assert.equal(crmRights({ user: userOf('dispatcher'), access: legacy, hasPermission }).read, false);
  assert.equal(crmRights({ user: userOf('manager'), access: legacy, hasPermission }).write, false);
  // Наборы: экран решает чтение.
  const sets = { legacy: false, views: ['payments'], money: 'none', scope: { all: true, depts: [] } };
  assert.equal(crmRights({ user: userOf('dispatcher'), access: sets, hasPermission }).read, true);
  assert.equal(crmRights({ user: userOf('sales'), access: { ...sets, views: ['sales'] }, hasPermission }).read, false);

  let r = makeCtx(db, userOf('dispatcher'), legacy, { pathname: '/api/crm/summary' });
  assert.equal(await crmApi(r.ctx), true);
  assert.equal(r.out.status, 403);

  r = makeCtx(db, null, legacy, { pathname: '/api/crm/summary' });
  await crmApi(r.ctx);
  assert.equal(r.out.status, 401);

  r = makeCtx(db, userOf('sales'), legacy, { pathname: '/api/other' });
  assert.equal(await crmApi(r.ctx), false);

  // Без денег: суммы вырезаны, счётчики остались.
  r = makeCtx(db, userOf('accountant'), { ...sets, views: ['payments'] }, { pathname: '/api/crm/receivables' });
  await crmApi(r.ctx);
  assert.equal(r.out.status, 200);
  assert.equal(r.out.body.rows.length, 1);
  assert.equal(r.out.body.rows[0].net, undefined);
  assert.equal(r.out.body.totals.count, 1);
  assert.equal(r.out.body.canPay, true);

  // Бухгалтерия не правит договоры.
  r = makeCtx(db, userOf('accountant'), legacy, { method: 'POST', pathname: '/api/crm/contracts', body: { customerName: 'Иней', paymentDays: 10 } });
  await crmApi(r.ctx);
  assert.equal(r.out.status, 403);

  // Продажи заводят договор — с аудитом; кривая отсрочка — 422.
  r = makeCtx(db, userOf('sales'), legacy, { method: 'POST', pathname: '/api/crm/contracts', body: { customerName: 'Иней', paymentDays: -3 } });
  await crmApi(r.ctx);
  assert.equal(r.out.status, 422);
  r = makeCtx(db, userOf('sales'), legacy, { method: 'POST', pathname: '/api/crm/contracts',
    body: { customerName: 'Иней', number: '5', signedOn: '2026-01-01', paymentDays: 14 } });
  await crmApi(r.ctx);
  assert.equal(r.out.status, 201);
  assert.equal(r.out.audits[0][2], 'create');
  const contractId = r.out.body.id;
  r = makeCtx(db, userOf('sales'), legacy, { method: 'PATCH', pathname: `/api/crm/contracts/${contractId}`, body: { paymentDays: 21 } });
  await crmApi(r.ctx);
  assert.equal(r.out.status, 200);
  assert.equal(db.prepare('SELECT payment_days, number FROM crm_contracts WHERE id=?').get(contractId).payment_days, 21);
  assert.equal(db.prepare('SELECT number FROM crm_contracts WHERE id=?').get(contractId).number, '5'); // прочее не стёрто

  // Воронка через API: отказ без причины — 422, с причиной — ок, возврат из отказа чистит причину.
  r = makeCtx(db, userOf('sales'), legacy, { method: 'POST', pathname: '/api/crm/leads', body: { company: 'Бета', stage: 'offer' } });
  await crmApi(r.ctx);
  assert.equal(r.out.status, 201);
  const leadId = r.out.body.id;
  assert.equal(db.prepare('SELECT owner_name FROM crm_leads WHERE id=?').get(leadId).owner_name, 'Тест sales');
  r = makeCtx(db, userOf('sales'), legacy, { method: 'PATCH', pathname: `/api/crm/leads/${leadId}`, body: { stage: 'lost' } });
  await crmApi(r.ctx);
  assert.equal(r.out.status, 422);
  r = makeCtx(db, userOf('sales'), legacy, { method: 'PATCH', pathname: `/api/crm/leads/${leadId}`, body: { stage: 'lost', lostReason: 'ушли к конкуренту' } });
  await crmApi(r.ctx);
  assert.equal(r.out.status, 200);
  assert.equal(r.out.audits[0][2], 'stage:lost');
  r = makeCtx(db, userOf('sales'), legacy, { method: 'PATCH', pathname: `/api/crm/leads/${leadId}`, body: { stage: 'won', wonCustomerName: 'Иней' } });
  await crmApi(r.ctx);
  const lead = db.prepare('SELECT stage, lost_reason, won_customer_name FROM crm_leads WHERE id=?').get(leadId);
  assert.deepEqual({ ...lead }, { stage: 'won', lost_reason: '', won_customer_name: 'Иней' });

  // Сумма лида скрыта у роли без денег.
  r = makeCtx(db, userOf('sales'), { legacy: false, views: ['crm'], money: 'none', scope: { all: true, depts: [] } }, { pathname: '/api/crm/leads' });
  await crmApi(r.ctx);
  assert.equal(r.out.status, 200);
  assert.equal('amount_estimate' in r.out.body.leads[0], false);
});

test('учёт долгов выключен: сумм и сроков долга нет, договоры и оплата работают', async t => {
  const db = freshDb(t);
  const trip = addTrip(db, { customer: 'Иней', status: 'unloaded', endsAt: '2026-10-01T10:00:00Z' });
  let r = makeCtx(db, userOf('sales'), legacy, { pathname: '/api/crm/summary', debtOn: false });
  await crmApi(r.ctx);
  assert.equal(r.out.body.receivablesOn, false);
  assert.equal(r.out.body.totals, null);
  assert.ok(r.out.body.customers.every(item => item.debt === null));
  r = makeCtx(db, userOf('accountant'), legacy, { pathname: '/api/crm/receivables', debtOn: false });
  await crmApi(r.ctx);
  assert.deepEqual(r.out.body.rows, []);
  // Оплата и её отмена — бухгалтерия; время и кто — в рейсе.
  r = makeCtx(db, userOf('sales'), legacy, { method: 'POST', pathname: `/api/crm/trips/${trip}/paid`, body: { paid: true }, debtOn: false });
  await crmApi(r.ctx);
  assert.equal(r.out.status, 403);
  r = makeCtx(db, userOf('accountant'), legacy, { method: 'POST', pathname: `/api/crm/trips/${trip}/paid`, body: { paid: true }, debtOn: false });
  await crmApi(r.ctx);
  assert.equal(r.out.status, 200);
  let row = db.prepare('SELECT status, paid_at, paid_by FROM trips WHERE id=?').get(trip);
  assert.equal(row.status, 'paid');
  assert.ok(row.paid_at);
  assert.equal(row.paid_by, 'Тест accountant');
  r = makeCtx(db, userOf('accountant'), legacy, { pathname: '/api/crm/receivables', debtOn: false });
  await crmApi(r.ctx);
  assert.equal(r.out.body.paid[0].id, trip);
  r = makeCtx(db, userOf('accountant'), legacy, { method: 'POST', pathname: `/api/crm/trips/${trip}/paid`, body: { paid: false }, debtOn: false });
  await crmApi(r.ctx);
  row = db.prepare('SELECT status, paid_at FROM trips WHERE id=?').get(trip);
  assert.deepEqual([row.status, row.paid_at], ['done', null]);
});

test('отсрочка одна: договор ↔ карточка клиента; факт отсрочки — медиана с 5 оплат', t => {
  const db = freshDb(t);
  addContract(db, { customer: 'Иней', signedOn: '2026-01-01', days: 14 });
  syncContractDays(db, 'Иней', undefined, TODAY);
  assert.equal(db.prepare('SELECT payment_days FROM customer_profiles WHERE customer_name=?').get('Иней').payment_days, 14);
  syncContractDays(db, 'иней', 30, TODAY); // правка в карточке → в действующий договор
  assert.equal(db.prepare(`SELECT payment_days FROM crm_contracts WHERE customer_name='Иней'`).get().payment_days, 30);
  const nowMs = Date.parse('2026-11-07T12:00:00Z');
  for (let i = 0; i < 4; i += 1) {
    const id = addTrip(db, { customer: 'Иней', status: 'paid', endsAt: `2026-10-0${i + 1}T10:00:00Z` });
    markTripPaid(db, id, true, 'бух', `2026-10-${String(i + 21).padStart(2, '0')}T10:00:00Z`);
  }
  assert.equal(factPaymentDays(db, 'Иней', { nowMs }).days, null);
  const id = addTrip(db, { customer: 'Иней', status: 'paid', endsAt: '2026-10-05T10:00:00Z' });
  markTripPaid(db, id, true, 'бух', '2026-10-25T10:00:00Z');
  assert.deepEqual(factPaymentDays(db, 'Иней', { nowMs }), { days: 20, samples: 5 });
});
