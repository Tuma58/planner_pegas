// ЦФО и затраты (проект «Слияние», блок 3, 07.11.2026).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/db.mjs';
import { cfoData, cfoScope } from '../src/cfo.mjs';
import { hashPassword } from '../src/security.mjs';
import { createStaffUser } from '../src/staff.mjs';

function freshDb(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pegas-cfo-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = openDatabase(path.join(directory, 'planner.db'), {
    username: 'root-admin', password: 'Temporary-password-2026', fullName: 'Администратор'
  });
  t.after(() => db.close());
  return db;
}
const categoriesOf = db => new Map(db.prepare('SELECT * FROM expense_categories').all().map(c => [c.id, c]));

test('статьи размечены по ЦФО, новые статьи на месте, привлечённого транспорта нет', t => {
  const db = freshDb(t);
  const cats = categoriesOf(db);
  assert.equal(cats.get('fuel').cfo, 'drv');
  assert.equal(cats.get('salary').cfo, 'drv');
  assert.equal(cats.get('fines').cfo, 'drv');
  assert.equal(cats.get('parts').cfo, 'toir');
  assert.equal(cats.get('repair').cfo, 'toir');
  assert.equal(cats.get('lease').cfo, 'staff');
  assert.equal(cats.get('evac').cfo, 'drv');
  assert.equal(cats.get('access').cfo, 'staff');
  assert.equal([...cats.values()].some(c => /привлеч/i.test(c.name)), false);
});

test('ЦФО: ₽ на машино-день, «не вносится», детализация штрафов, свод', t => {
  const db = freshDb(t);
  const items = [
    { category_id: 'fuel', amount: 122000, vat: 1, supplier: 'РН-Карт · АЗС 1' },
    { category_id: 'fines', amount: 5000, vat: 0, supplier: 'Dornet · штрафы' },
    { category_id: 'fines', amount: 3000, vat: 0, supplier: 'Платон' },
    { category_id: 'parts', amount: 24400, vat: 1, supplier: '' }
  ];
  const snap = { netRevenue: 1_000_000, contribution: 400_000, loadedKm: 10_000, emptyKm: 1200, emptyCost: 66_000,
    utilization: { techDays: 100, lineDays: 80, workDays: 50, calendarDays: 110 } };
  const data = cfoData({ from: '2026-07-01', to: '2026-07-31', items, categories: categoriesOf(db), vatRate: 0.22,
    snap, owners: {}, demurrage: { billed: 1000, open: 2000 }, incidents: { act: 1 } },
  { all: true, depts: ['drv', 'toir', 'log', 'staff'] });
  const drv = data.centers.find(c => c.key === 'drv');
  assert.equal(drv.net, 100000 + 8000);
  assert.equal(drv.perMd, Math.round(108000 / 80));
  const fines = drv.articles.find(a => a.id === 'fines');
  assert.deepEqual(fines.detail.map(d => d.key).sort(), ['Dornet', 'Платон']);
  const wash = drv.articles.find(a => a.id === 'wash');
  assert.equal(wash.count, 0); // «не вносится» — без подмены нормативом
  const toir = data.centers.find(c => c.key === 'toir');
  assert.equal(toir.perMd, 200);
  const log = data.centers.find(c => c.key === 'log');
  assert.equal(log.result.revenuePerMd, 20000);
  assert.equal(log.result.ratePerKm, 100);
  assert.equal(log.losses.emptyCost, 66000);
  assert.equal(data.total.profit, 1_000_000 - 128000);
  // Руководитель отдела видит только свой ЦФО и без свода.
  const own = cfoData({ from: 'a', to: 'b', items, categories: categoriesOf(db), vatRate: 0.22, snap },
    { all: false, depts: ['toir'] });
  assert.deepEqual(own.centers.map(c => c.key), ['toir']);
  assert.equal(own.total, undefined);
  // Пустые машино-дни — без деления на ноль.
  const empty = cfoData({ items: [], categories: categoriesOf(db), vatRate: 0.22, snap: null }, { all: true, depts: ['drv'] });
  assert.equal(empty.centers[0].perMd, null);
});

test('видимость ЦФО: по доступу к затратам и по должности', t => {
  const db = freshDb(t);
  const make = n => {
    const positionId = db.prepare('SELECT id FROM org_positions WHERE n=?').get(n).id;
    const r = createStaffUser(db, { fullName: `Тест ${n}`, positionId }, { hashPassword });
    return db.prepare('SELECT * FROM users WHERE id=?').get(r.id);
  };
  assert.deepEqual(cfoScope(db, make(14), false), { all: false, depts: ['toir'] });
  assert.deepEqual(cfoScope(db, make(10), false), { all: false, depts: ['drv'] });
  assert.equal(cfoScope(db, make(1), false).all, true);
  assert.equal(cfoScope(db, make(20), false), null); // слесарь
  assert.equal(cfoScope(db, make(20), true).all, true);
});
