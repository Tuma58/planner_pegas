// Структура направления СТ (проект «Слияние», блок 1, 05.11.2026).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/db.mjs';
import { hashPassword } from '../src/security.mjs';
import { canLogin, createStaffUser, staffList, updateStaffUser } from '../src/staff.mjs';
import { archivePosition, createPosition, structureData, updatePosition } from '../src/structure.mjs';
import { effectivePermissions } from '../src/permissions.mjs';

function freshDb(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pegas-structure-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = openDatabase(path.join(directory, 'planner.db'), {
    username: 'root-admin', password: 'Temporary-password-2026', fullName: 'Администратор'
  });
  t.after(() => db.close());
  return db;
}

test('структура СТ загружается один раз: 4 отдела, 24 должности, штат 250', t => {
  const db = freshDb(t);
  const data = structureData(db);
  assert.equal(data.depts.length, 4);
  assert.equal(data.positions.length, 24);
  assert.equal(data.totals.headcount, 250);
  assert.equal(data.totals.driverHeadcount, 195);
  assert.equal(data.totals.officeHeadcount, 55);
  // Каждая должность — в группе своего отдела, паспорт на месте.
  const groups = new Map(data.groups.map(group => [group.id, group]));
  for (const position of data.positions) {
    assert.equal(groups.get(position.group)?.dept, position.dept, position.title);
  }
  const control = data.positions.find(position => position.title.startsWith('Диспетчер-контролёр'));
  assert.equal(groups.get(control.group).name, 'Группа контроля');
  assert.equal(control.dept, 'log');
  assert.ok(control.passport.duties.length > 3);
  // Повторное открытие базы не дублирует и не затирает правки.
  updatePosition(db, control.id, { headcount: 9 });
  assert.equal(structureData(db).positions.find(item => item.id === control.id).headcount, 9);
});

test('сотрудник без роли — в штате, но без входа и без прав', t => {
  const db = freshDb(t);
  const position = structureData(db).positions.find(item => item.title === 'Слесарь');
  const result = createStaffUser(db, { fullName: 'Иванов Иван Иванович', positionId: position.id },
    { hashPassword });
  assert.ok(result.ok, result.error);
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(result.id);
  assert.equal(user.role, '');
  assert.equal(user.job_role, 'Слесарь');
  assert.equal(canLogin(user), false);
  assert.deepEqual(effectivePermissions(user), []);
  const data = structureData(db);
  const fact = data.positions.find(item => item.id === position.id);
  assert.equal(fact.fact, 1);
  assert.equal(fact.vacancies, position.headcount - 1);
  assert.equal(data.totals.noRole, 1);
  // Роль без пароля не принимается: войти было бы нечем.
  assert.equal(createStaffUser(db, { fullName: 'Петров', roles: ['logist'], username: 'petrov' },
    { hashPassword }).ok, false);
});

test('должность пишет job_role, переименование должности доходит до людей', t => {
  const db = freshDb(t);
  const positions = structureData(db).positions;
  const logist = positions.find(item => item.title === 'Логист-диспетчер');
  const created = createStaffUser(db, { fullName: 'Сидорова Анна', roles: ['logist'], username: 'sidorova',
    password: 'Very-strong-password-2026', jobRole: 'старый текст' }, { hashPassword });
  const user = () => db.prepare('SELECT * FROM users WHERE id=?').get(created.id);
  assert.equal(user().job_role, 'старый текст');
  assert.equal(user().position_id, null);
  assert.equal(canLogin(user()), true);
  assert.ok(updateStaffUser(db, created.id, { positionId: logist.id }, {}).ok);
  assert.equal(user().job_role, 'Логист-диспетчер');
  updatePosition(db, logist.id, { title: 'Логист-диспетчер группы назначения' });
  assert.equal(user().job_role, 'Логист-диспетчер группы назначения');
  // Водители не назначаются офисным — их должность ведёт Ресурс.
  const driverPool = positions.find(item => item.driverPool);
  assert.equal(updateStaffUser(db, created.id, { positionId: driverPool.id }, {}).ok, false);
  const list = staffList(db);
  assert.equal(list.users.find(item => item.id === created.id).dept, 'log');
});

test('должность создаётся в группе и упраздняется только пустой', t => {
  const db = freshDb(t);
  const data = structureData(db);
  const group = data.groups.find(item => item.dept === 'toir');
  const created = createPosition(db, { group: group.id, title: 'Шиномонтажник', headcount: 2 });
  assert.ok(created.ok);
  const person = createStaffUser(db, { fullName: 'Кузнецов', positionId: created.id }, { hashPassword });
  assert.equal(archivePosition(db, created.id).ok, false);
  updateStaffUser(db, person.id, { positionId: "" }, {});
  assert.equal(archivePosition(db, created.id).ok, true);
  assert.equal(structureData(db).positions.some(item => item.id === created.id), false);
  assert.equal(updatePosition(db, data.positions[0].id, { headcount: -1 }).ok, false);
});
