// Склад запчастей ТОиР: остатки, приход, расход на наряд, живой
// неснижаемый запас, «к закупке», хук в журнал затрат, права (07.11.2026).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../src/db.mjs';
import { hasPermission } from '../src/permissions.mjs';
import { leadSamples, leadTimeOf, migrateParts, minStockOf, partsApi, partsConfig, partsForOrder,
  partsNormsReport, partsRights, partsStock, toBuyQty, PARTS_DEFAULTS } from '../src/parts.mjs';

const TODAY = '2026-11-07';

function freshDb(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pegas-parts-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = openDatabase(path.join(directory, 'planner.db'), {
    username: 'root-admin', password: 'Temporary-password-2026', fullName: 'Администратор'
  });
  t.after(() => db.close());
  migrateParts(db);
  migrateParts(db); // идемпотентно
  // Пользователи обвязки — живые строки (на них ссылаются settings/expenses).
  for (const role of ['mechanic', 'admin', 'manager']) {
    db.prepare(`INSERT OR IGNORE INTO users(id,username,full_name,password_hash,role) VALUES(?,?,?,?,'manager')`)
      .run(`u-${role}`, `t-${role}`, `Тест ${role}`, 'x');
  }
  return db;
}

const addItem = (db, row = {}) => {
  const id = randomUUID();
  db.prepare(`INSERT INTO parts_items(id,code,name,unit,manual_min,lead_days_manual) VALUES(?,?,?,?,?,?)`)
    .run(id, row.code || '', row.name || 'Фильтр масляный', row.unit || 'шт', row.manualMin ?? null, row.leadManual ?? null);
  return id;
};
const addOrder = (db, status = 'in_progress') => {
  const vehicle = db.prepare('SELECT id FROM vehicles LIMIT 1').get().id;
  const id = randomUUID();
  db.prepare(`INSERT INTO repair_orders(id,vehicle_id,status,purpose) VALUES(?,?,?,?)`).run(id, vehicle, status, 'ТО');
  return { id, vehicle };
};
const move = (db, { item, kind, qty, day, order = null, cost = null }) => db.prepare(`INSERT INTO parts_moves(id,item_id,kind,qty,unit_cost_net,order_id,day,note)
  VALUES(?,?,?,?,?,?,?,?)`).run(randomUUID(), item, kind, qty, cost, order, day, kind === 'adjust' ? 'пересчёт' : '');
const request = (db, { item, from, to, qty = 1 }) => db.prepare(`INSERT INTO parts_requests(id,item_id,qty,requested_on,status,received_on)
  VALUES(?,?,?,?,?,?)`).run(randomUUID(), item, qty, from, to ? 'received' : 'open', to || null);

test('цели склада: пусто → по умолчанию, ноль — осознанно, мусор отвергнут', () => {
  assert.deepEqual(partsConfig({}), { ...PARTS_DEFAULTS });
  const cfg = partsConfig({ parts: { windowDays: 30, safetyFactor: 0, minLeadSamples: '', leadMaxDays: 'abc' } });
  assert.equal(cfg.windowDays, 30);
  assert.equal(cfg.safetyFactor, 0); // ноль не затирается дефолтом
  assert.equal(cfg.minLeadSamples, PARTS_DEFAULTS.minLeadSamples);
  assert.equal(cfg.leadMaxDays, PARTS_DEFAULTS.leadMaxDays);
  // Перевёрнутый коридор — оба края по умолчанию.
  const bad = partsConfig({ parts: { leadMinDays: 10, leadMaxDays: 5 } });
  assert.equal(bad.leadMinDays, PARTS_DEFAULTS.leadMinDays);
});

test('срок поставки: факт позиции → ручной → склад → неизвестен; кламп отвергает выбросы', () => {
  const cfg = partsConfig({ parts: { minLeadSamples: 3, leadMinDays: 1, leadMaxDays: 30 } });
  const rows = [['2026-10-01', '2026-10-05'], ['2026-10-10', '2026-10-12'], ['2026-10-20', '2026-10-26'], ['2026-09-01', '2026-11-01']]
    .map(([requested_on, received_on]) => ({ requested_on, received_on }));
  const samples = leadSamples(rows, cfg);
  assert.deepEqual(samples.ok, [4, 2, 6]);
  assert.equal(samples.rejected, 1); // 61 сутки — вне коридора
  assert.deepEqual(leadTimeOf({ itemSamples: samples, manualDays: 10, parkSamples: null, cfg }),
    { samples: 3, rejected: 1, days: 4, source: 'learned' }); // факт важнее ручного
  const few = leadSamples(rows.slice(0, 2), cfg);
  assert.equal(leadTimeOf({ itemSamples: few, manualDays: 10, parkSamples: samples, cfg }).source, 'manual');
  assert.equal(leadTimeOf({ itemSamples: few, manualDays: null, parkSamples: samples, cfg }).days, 4);
  assert.equal(leadTimeOf({ itemSamples: few, manualDays: null, parkSamples: samples, cfg }).source, 'park');
  assert.equal(leadTimeOf({ itemSamples: few, manualDays: null, parkSamples: few, cfg }).source, 'none');
  // Ручной ноль («есть у поставщика день в день») — осознанное значение.
  assert.equal(leadTimeOf({ itemSamples: few, manualDays: 0, parkSamples: null, cfg }).days, 0);
});

test('неснижаемый запас: расход/сутки × срок × запас, не ниже разовой выдачи; ручной переопределяет', () => {
  // 18 шт за 90 сут = 0,2/сут × 10 сут = 2, медиана выдачи 2 → 2.
  let min = minStockOf({ issues: [2, 2, 2, 2, 2, 2, 2, 2, 2], windowDays: 90, leadDays: 10, safetyFactor: 1, manualMin: null });
  assert.equal(min.qty, 2);
  assert.equal(min.source, 'live');
  assert.equal(min.dailyUse, 0.2);
  // Редкая выдача комплектом: 4 колеса раз в квартал, срок 3 сут → не 1, а 4.
  min = minStockOf({ issues: [4], windowDays: 90, leadDays: 3, safetyFactor: 1, manualMin: null });
  assert.equal(min.qty, 4);
  // Срок неизвестен — запас не считается, а не выдумывается.
  min = minStockOf({ issues: [4], windowDays: 90, leadDays: null, safetyFactor: 1, manualMin: null });
  assert.equal(min.qty, null);
  assert.equal(min.source, 'no_lead');
  // Расхода не было — держать нечего.
  min = minStockOf({ issues: [], windowDays: 90, leadDays: 5, safetyFactor: 1, manualMin: null });
  assert.deepEqual([min.qty, min.source], [0, 'no_use']);
  // Ручной минимум всегда главнее, живой виден рядом.
  min = minStockOf({ issues: [30, 60], windowDays: 90, leadDays: 6, safetyFactor: 1.5, manualMin: 5 });
  assert.equal(min.qty, 5);
  assert.equal(min.source, 'manual');
  assert.equal(min.live, 45); // max(1×6×1,5 = 9, медиана 45)
  // Ручной ноль — «не держим», не пустота.
  assert.equal(minStockOf({ issues: [3], windowDays: 90, leadDays: 6, safetyFactor: 1, manualMin: 0 }).qty, 0);
  assert.equal(toBuyQty(5, 1, 2), 2);
  assert.equal(toBuyQty(5, 3, 2), 0);
  assert.equal(toBuyQty(5, 1, 0, 6), 6); // кратность: нужно 4, упаковка 6 → 6
  assert.equal(toBuyQty(13, 0, 0, 6), 18);
  assert.equal(toBuyQty(5, 5, 0, 6), 0);
  assert.equal(toBuyQty(2.3, 0, 0), 3);
  assert.equal(toBuyQty(null, 0, 0), 0);
});

test('сводка: остаток из журнала, отменённое не считается, к закупке с учётом заказанного', t => {
  const db = freshDb(t);
  const filter = addItem(db, { name: 'Фильтр масляный' });
  const order = addOrder(db);
  move(db, { item: filter, kind: 'receipt', qty: 10, day: '2026-09-01', cost: 500 });
  move(db, { item: filter, kind: 'receipt', qty: 10, day: '2026-09-02', cost: 700 });
  move(db, { item: filter, kind: 'issue', qty: 9, day: '2026-10-01', order: order.id });
  move(db, { item: filter, kind: 'issue', qty: 9, day: '2026-10-15', order: order.id });
  db.prepare(`UPDATE parts_moves SET cancelled_at='x' WHERE kind='receipt' AND day='2026-09-02'`).run(); // сторно
  move(db, { item: filter, kind: 'receipt', qty: 10, day: '2026-09-03', cost: 700 });
  // Срок поставки: три факта по 10 сут.
  for (const [from, to] of [['2026-08-01', '2026-08-11'], ['2026-08-20', '2026-08-30'], ['2026-09-10', '2026-09-20']]) request(db, { item: filter, from, to });
  request(db, { item: filter, from: '2026-11-01', qty: 1 }); // открытая заявка
  const data = partsStock(db, { settings: {}, today: TODAY });
  const row = data.items.find(item => item.id === filter);
  assert.equal(row.stock, 2); // 20 − 18
  assert.equal(row.avgCost, 600); // средневзвешенная по живым приходам
  assert.equal(row.lead.source, 'learned');
  assert.equal(row.lead.days, 10);
  assert.equal(row.min.qty, 9); // 18/90 × 10 = 2, медиана выдачи 9
  assert.equal(row.below, true);
  assert.equal(row.onOrder, 1);
  assert.equal(row.toBuy, 6); // 9 − 2 − 1
  assert.equal(row.windowFull, false); // история с 01.09 короче окна 90 сут
  assert.equal(data.totals.toBuy, 1);
  const report = partsNormsReport(db, { settings: {}, today: TODAY, save: true });
  assert.equal(report.lead.learned, 1);
  assert.match(report.line, /Склад запчастей: 1 позиций/);
  assert.match(partsNormsReport(db, { settings: {}, today: TODAY }).line, /к закупке 1/);
});

// Обвязка маршрутов: ctx как у сервера.
function makeCtx(db, user, access, { method = 'GET', pathname, search = '', body = {}, settings = {} } = {}) {
  const out = { status: 0, body: null, audits: [] };
  const ctx = {
    db, user, access, pathname, url: new URL(`http://x${pathname}${search}`),
    request: { method }, response: {},
    json: (_r, status, obj) => { out.status = status; out.body = obj; },
    errorJson: (_r, status, msg) => { out.status = status; out.body = { error: msg }; },
    readJson: async () => body,
    audit: (...args) => out.audits.push(args),
    requestIp: () => '127.0.0.1',
    settingsObject: () => ({ general: { timezone: 'Europe/Moscow' }, calculation: { vatRate: 0.2 }, ...settings }), hasPermission
  };
  return { ctx, out };
}
const legacy = { legacy: true, views: null, money: 'full', scope: { all: true, depts: [] } };
const userOf = role => ({ id: `u-${role}`, username: role, full_name: `Тест ${role}`, active: 1, role, roles: JSON.stringify([role]) });
const call = async (db, user, access, opts) => { const r = makeCtx(db, user, access, opts); const handled = await partsApi(r.ctx); return { handled, ...r.out }; };

test('права: экран parts, запись по fleet:write, цены скрыты без денег', async t => {
  const db = freshDb(t);
  assert.deepEqual(partsRights({ user: userOf('mechanic'), access: legacy, hasPermission }),
    { read: true, write: true, settings: false, money: true });
  assert.equal(partsRights({ user: userOf('manager'), access: legacy, hasPermission }).write, false);
  assert.equal(partsRights({ user: userOf('manager'), access: legacy, hasPermission }).read, true);
  assert.equal(partsRights({ user: userOf('dispatcher'), access: legacy, hasPermission }).read, false);
  const sets = { legacy: false, views: ['remzona'], money: 'none', scope: { all: false, depts: ['toir'] } };
  assert.equal(partsRights({ user: userOf('mechanic'), access: sets, hasPermission }).read, false); // нет экрана
  const toir = { ...sets, views: ['remzona', 'parts'] };
  assert.equal(partsRights({ user: userOf('mechanic'), access: toir, hasPermission }).write, true);

  assert.equal((await call(db, userOf('mechanic'), legacy, { pathname: '/api/other' })).handled, false);
  assert.equal((await call(db, null, legacy, { pathname: '/api/parts' })).status, 401);
  assert.equal((await call(db, userOf('dispatcher'), legacy, { pathname: '/api/parts' })).status, 403);
  // Руководитель только читает.
  assert.equal((await call(db, userOf('manager'), legacy, { method: 'POST', pathname: '/api/parts/items', body: { name: 'Ремень' } })).status, 403);

  let r = await call(db, userOf('mechanic'), toir, { method: 'POST', pathname: '/api/parts/items', body: { name: 'Колодки', code: 'BP-1', manualMin: -1 } });
  assert.equal(r.status, 422);
  r = await call(db, userOf('mechanic'), toir, { method: 'POST', pathname: '/api/parts/items', body: { name: 'Колодки', code: 'BP-1' } });
  assert.equal(r.status, 201);
  const itemId = r.body.id;
  r = await call(db, userOf('mechanic'), toir, { method: 'POST', pathname: '/api/parts/items', body: { name: 'Колодки 2', code: 'bp-1' } });
  assert.equal(r.status, 409); // артикул занят
  // Без денег цена прихода не принимается и не отдаётся.
  r = await call(db, userOf('mechanic'), toir, { method: 'POST', pathname: '/api/parts/receipts', body: { itemId, qty: 4, price: 1000 } });
  assert.equal(r.status, 201);
  assert.equal(db.prepare('SELECT price FROM parts_moves WHERE id=?').get(r.body.id).price, null);
  r = await call(db, userOf('mechanic'), toir, { pathname: '/api/parts/summary' });
  assert.equal(r.status, 200);
  assert.equal(r.body.items[0].stock, 4);
  assert.equal('avgCost' in r.body.items[0], false);
  assert.equal('stockValue' in r.body.totals, false);
  // С деньгами — цена как в документе, себестоимость без НДС по ставке калькуляции.
  r = await call(db, userOf('mechanic'), legacy, { method: 'POST', pathname: '/api/parts/receipts', body: { itemId, qty: 2, price: 1200, vat: true } });
  assert.equal(db.prepare('SELECT unit_cost_net FROM parts_moves WHERE id=?').get(r.body.id).unit_cost_net, 1000);
  r = await call(db, userOf('mechanic'), legacy, { pathname: '/api/parts/summary' });
  assert.equal(r.body.items[0].avgCost, 1000); // приход без цены в среднюю не входит
  // Цели склада — только settings:write.
  assert.equal((await call(db, userOf('mechanic'), legacy, { method: 'PUT', pathname: '/api/parts/settings', body: { windowDays: 30 } })).status, 403);
  r = await call(db, userOf('admin'), legacy, { method: 'PUT', pathname: '/api/parts/settings', body: { windowDays: 30, safetyFactor: 0 } });
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(db.prepare(`SELECT value_json FROM settings WHERE key='parts'`).get().value_json),
    { windowDays: 30, safetyFactor: 0 });
});

test('расход на наряд: только открытый наряд, не больше остатка; сторно; заявка закрывается приходом', async t => {
  const db = freshDb(t);
  const user = userOf('mechanic');
  const item = (await call(db, user, legacy, { method: 'POST', pathname: '/api/parts/items', body: { name: 'Масло 10W-40', unit: 'л' } })).body.id;
  const reqId = (await call(db, user, legacy, { method: 'POST', pathname: '/api/parts/requests', body: { itemId: item, qty: 20, day: '2026-11-01' } })).body.id;
  let r = await call(db, user, legacy, { method: 'POST', pathname: '/api/parts/receipts',
    body: { itemId: item, qty: 20, price: 300, vat: false, requestId: reqId, day: '2026-10-30' } });
  assert.equal(r.status, 422); // приход раньше заявки
  r = await call(db, user, legacy, { method: 'POST', pathname: '/api/parts/receipts',
    body: { itemId: item, qty: 20, price: 300, vat: false, requestId: reqId, day: '2026-11-05' } });
  assert.equal(r.status, 201);
  const receiptId = r.body.id;
  assert.deepEqual({ ...db.prepare('SELECT status, received_on FROM parts_requests WHERE id=?').get(reqId) },
    { status: 'received', received_on: '2026-11-05' });

  const open = addOrder(db, 'in_progress');
  const closed = addOrder(db, 'released');
  r = await call(db, user, legacy, { method: 'POST', pathname: '/api/parts/issues', body: { itemId: item, qty: 6, orderId: closed.id } });
  assert.equal(r.status, 409);
  r = await call(db, user, legacy, { method: 'POST', pathname: '/api/parts/issues', body: { itemId: item, qty: 26, orderId: open.id } });
  assert.equal(r.status, 409); // больше остатка
  assert.match(r.body.error, /На складе 20 л/);
  r = await call(db, user, legacy, { method: 'POST', pathname: '/api/parts/issues', body: { itemId: item, qty: 6, orderId: open.id } });
  assert.equal(r.status, 201);
  const issueId = r.body.id;
  const issued = db.prepare('SELECT vehicle_id, unit_cost_net FROM parts_moves WHERE id=?').get(issueId);
  assert.equal(issued.vehicle_id, open.vehicle); // машина — из наряда
  assert.equal(issued.unit_cost_net, 300);
  assert.equal(partsForOrder(db, open.id)[0].cost, 1800);
  r = await call(db, user, legacy, { pathname: `/api/parts/orders/${open.id}` });
  assert.equal(r.body.cost, 1800);
  r = await call(db, user, legacy, { pathname: '/api/parts/orders' });
  assert.equal(r.body.orders.some(order => order.id === open.id), true);
  assert.equal(r.body.orders.some(order => order.id === closed.id), false);

  // Хук затрат по умолчанию выключен — журнал не тронут.
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM expenses WHERE import_key LIKE 'parts:%'`).get().n, 0);

  // Отмена прихода, из которого уже выдано, уводит в минус — нельзя.
  r = await call(db, user, legacy, { method: 'POST', pathname: `/api/parts/moves/${receiptId}/cancel`, body: { reason: 'ошибка' } });
  assert.equal(r.status, 409);
  r = await call(db, user, legacy, { method: 'POST', pathname: `/api/parts/moves/${issueId}/cancel`, body: {} });
  assert.equal(r.status, 422); // без причины
  r = await call(db, user, legacy, { method: 'POST', pathname: `/api/parts/moves/${issueId}/cancel`, body: { reason: 'не та позиция' } });
  assert.equal(r.status, 200);
  r = await call(db, user, legacy, { method: 'POST', pathname: `/api/parts/moves/${receiptId}/cancel`, body: { reason: 'ошибка' } });
  assert.equal(r.status, 200);
  assert.equal(db.prepare('SELECT status FROM parts_requests WHERE id=?').get(reqId).status, 'open'); // заявка снова ждёт

  // Инвентаризация: факт → разница, причина обязательна.
  await call(db, user, legacy, { method: 'POST', pathname: '/api/parts/receipts', body: { itemId: item, qty: 10 } });
  r = await call(db, user, legacy, { method: 'POST', pathname: '/api/parts/adjust', body: { itemId: item, counted: 8 } });
  assert.equal(r.status, 422);
  r = await call(db, user, legacy, { method: 'POST', pathname: '/api/parts/adjust', body: { itemId: item, counted: 8, reason: 'пролив' } });
  assert.equal(r.status, 201);
  assert.equal(r.body.delta, -2);
  r = await call(db, user, legacy, { pathname: '/api/parts/moves', search: `?item=${item}` });
  assert.equal(r.body.moves.length, 4); // отменённые видны в журнале
  assert.equal(partsStock(db, { today: TODAY }).items[0].stock, 8);
});

test('затрата при закупке: выдача на наряд только списывает со склада, журнал затрат не трогает', async t => {
  const db = freshDb(t);
  const user = userOf('mechanic');
  const item = (await call(db, user, legacy, { method: 'POST', pathname: '/api/parts/items', body: { name: 'Фильтр топливный' } })).body.id;
  await call(db, user, legacy, { method: 'POST', pathname: '/api/parts/receipts', body: { itemId: item, qty: 5, price: 1200, vat: true } });
  const order = addOrder(db);
  const before = db.prepare('SELECT COUNT(*) n FROM expenses').get().n;
  const r = await call(db, user, legacy, { method: 'POST', pathname: '/api/parts/issues', body: { itemId: item, qty: 2, orderId: order.id },
    settings: { parts: { expenseOnIssue: true } } }); // старый флаг ничего не включает
  assert.equal(r.status, 201);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM expenses').get().n, before);
  assert.equal(partsStock(db, { today: TODAY }).items[0].stock, 3);
  assert.equal(db.prepare('SELECT unit_cost_net FROM parts_moves WHERE id=?').get(r.body.id).unit_cost_net, 1000); // себестоимость для аналитики
});
