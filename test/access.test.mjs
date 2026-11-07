// Роли-наборы, область и защита денег (поле управления, 07.11.2026).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/db.mjs';
import { accessOf, assignRoleSets, broadcastTextFor, roleSets, stripOrders, stripSmall, stripTrips } from '../src/access.mjs';
import { createStaffUser, canLogin } from '../src/staff.mjs';
import { hashPassword } from '../src/security.mjs';
import { effectivePermissions } from '../src/permissions.mjs';
import { scopeStructure, structureData } from '../src/structure.mjs';
import { cfoScope } from '../src/cfo.mjs';

function freshDb(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pegas-access-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = openDatabase(path.join(directory, 'planner.db'), {
    username: 'root-admin', password: 'Temporary-password-2026', fullName: 'Администратор'
  });
  t.after(() => db.close());
  return db;
}
const person = (db, n, sets) => {
  const positionId = db.prepare('SELECT id FROM org_positions WHERE n=?').get(n).id;
  const r = createStaffUser(db, { fullName: `Сотрудник ${n}`, positionId, username: `u${n}`,
    password: 'Very-strong-password-2026' }, { hashPassword });
  assert.ok(assignRoleSets(db, r.id, sets).ok);
  return db.prepare('SELECT * FROM users WHERE id=?').get(r.id);
};

test('утверждённые роли-наборы на месте; набор пишет старые коды прав', t => {
  const db = freshDb(t);
  const sets = roleSets(db);
  assert.equal(sets.length, 14); // 12 по таблице 9.1 + «Охранник-парковщик» (КПП) + «Контролёр техсостояния» (Выпуск), 07.11
  const head = person(db, 5, ['log_head']);
  assert.deepEqual(JSON.parse(head.roles).sort(), ['dispatcher', 'logist', 'sales']);
  assert.ok(canLogin(head));
  assert.ok(effectivePermissions(head).includes('orders:write'));
  const access = accessOf(db, head);
  assert.deepEqual(access.scope, { all: false, depts: ['log'] });
  assert.equal(access.money, 'full');
  assert.ok(access.views.includes('structure') && !access.views.includes('remzona') && !access.views.includes('dashboard'));
  // Админ-набор назначает только администратор; снятие — без входа.
  const plain = person(db, 7, ['log_assign']);
  assert.equal(assignRoleSets(db, plain.id, ['admin']).ok, false);
  assert.ok(assignRoleSets(db, plain.id, []).ok);
  assert.equal(canLogin(db.prepare('SELECT * FROM users WHERE id=?').get(plain.id)), false);
});

test('деньги режутся по уровню набора', t => {
  const db = freshDb(t);
  assert.equal(accessOf(db, person(db, 8, ['log_ctrl'])).money, 'none');
  assert.equal(accessOf(db, person(db, 7, ['log_assign'])).money, 'rates');
  // Совмещение: лучший уровень из наборов.
  assert.equal(accessOf(db, person(db, 6, ['log_ctrl', 'log_plan'])).money, 'rates');
  const trips = [{ id: 1, revenue_vat: 100000, demurrage_vat: 5000, cash: 'нал', customer_name: 'К' }];
  assert.equal(stripTrips(trips, 'none')[0].revenue_vat, null);
  assert.equal(stripTrips(trips, 'none')[0].customer_name, 'К');
  assert.equal(stripTrips(trips, 'rates')[0].revenue_vat, 100000);
  assert.equal(stripOrders([{ rate_vat: 90000 }], 'none')[0].rate_vat, null);
  const small = { revenuePlans: [{ target_net: 1 }], forecastSnapshot: { x: 1 }, demurrage: { openAmount: 9 },
    routes: [{ target_per_day: 50000 }], vehicles: [{ run_rate: { km: 500 } }] };
  assert.deepEqual(stripSmall(small, 'rates').revenuePlans, []);
  assert.ok(stripSmall(small, 'rates').demurrage);
  assert.equal(stripSmall(small, 'none').demurrage, null);
  assert.equal(stripSmall(small, 'none').routes[0].target_per_day, null);
  assert.deepEqual(stripSmall(small, 'none').vehicles, small.vehicles); // темп пробега — не деньги
  assert.equal(stripSmall(small, 'full'), small);
});

test('мини-структура: руководитель отдела видит только свой отдел', t => {
  const db = freshDb(t);
  const head = person(db, 14, ['toir_head']);
  const view = scopeStructure(structureData(db), accessOf(db, head).scope);
  assert.deepEqual(view.depts.map(item => item.key), ['toir']);
  assert.ok(view.positions.every(item => item.dept === 'toir'));
  assert.equal(view.totals.driverHeadcount, 0);
  assert.deepEqual(cfoScope(db, head, false), { all: false, depts: ['toir'] });
  // Механик ЦФО не видит вовсе; руководитель направления — всё.
  assert.equal(cfoScope(db, person(db, 15, ['toir_mech']), false), null);
  const director = person(db, 1, ['dir_head']);
  assert.equal(accessOf(db, director).scope.all, true);
  assert.equal(cfoScope(db, director, false).all, true);
});

test('без наборов — прежняя модель (переходный период)', t => {
  const db = freshDb(t);
  const admin = db.prepare(`SELECT * FROM users WHERE username='root-admin'`).get();
  const access = accessOf(db, admin);
  assert.equal(access.legacy, true);
  assert.equal(access.views, null);
  assert.equal(access.money, 'full');
});

test('рассылки с деньгами: полный текст — только уровню «все», остальным версия без денег', t => {
  const db = freshDb(t);
  const head = person(db, 5, ['log_head']);     // full
  const planner = person(db, 6, ['log_plan']);  // rates
  const control = person(db, 8, ['log_ctrl']);  // none
  const options = { money: 'full', plain: 'без денег' };
  assert.equal(broadcastTextFor(db, head, 'выручка 5 млн', options), 'выручка 5 млн');
  assert.equal(broadcastTextFor(db, planner, 'выручка 5 млн', options), 'без денег');
  assert.equal(broadcastTextFor(db, control, 'маржа', { money: 'full' }), null);
  assert.equal(broadcastTextFor(db, control, 'смена', {}), 'смена'); // без денег — всем
});
