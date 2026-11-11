// Доступ в планер (10.11.2026): автологин и временный пароль из
// справочника, обязательная смена при первом входе, гости со сроком,
// права должности и свои наборы.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/db.mjs';
import { hashPassword, verifyPassword } from '../src/security.mjs';
import { accessOf, createRoleSet, roleSets, updateRoleSet } from '../src/access.mjs';
import { canLogin, createStaffUser } from '../src/staff.mjs';
import { createPosition, positionById, structureData, updatePosition } from '../src/structure.mjs';
import { effectivePermissions } from '../src/permissions.mjs';
import {
  changeOwnPassword, createGuest, generatePassword, guestExpired, issueAccess, issueAccessBulk,
  loginBase, passwordProblem, uniqueLogin, updateGuest
} from '../src/credentials.mjs';
import { assignRoleSets } from '../src/access.mjs';

function freshDb(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pegas-cred-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = openDatabase(path.join(directory, 'planner.db'), {
    username: 'root-admin', password: 'Temporary-password-2026', fullName: 'Администратор'
  });
  t.after(() => db.close());
  return db;
}
const hire = (db, fullName, positionId = 'st-p9') => {
  const r = createStaffUser(db, { fullName, positionId }, { hashPassword });
  assert.ok(r.ok, r.error);
  return r.id;
};
const userRow = (db, id) => db.prepare('SELECT * FROM users WHERE id=?').get(id);

test('логин из ФИО: транслит фамилии и инициалы, занятый — с цифрой', t => {
  const db = freshDb(t);
  assert.equal(loginBase('Токарева Вера'), 'tokareva.v');
  assert.equal(loginBase('Бычков Вячеслав Александрович'), 'bychkov.va');
  assert.equal(loginBase('Ёфина Юлия'), 'efina.y');
  assert.equal(loginBase('Щукарев Олег'), 'shchukarev.o');
  const first = hire(db, 'Токарева Вера');
  assignRoleSets(db, first, ['log_ctrl']);
  assert.equal(issueAccess(db, first, { hashPassword }).username, 'tokareva.v');
  assert.equal(uniqueLogin(db, 'Токарева Валентина'), 'tokareva.v2');
});

test('временный пароль: 12 знаков без похожих символов, хранится только хэшем', () => {
  for (let i = 0; i < 50; i += 1) {
    const password = generatePassword();
    assert.match(password, /^[a-km-zA-HJ-NP-Z2-9]{4}-[a-km-zA-HJ-NP-Z2-9]{4}-[a-km-zA-HJ-NP-Z2-9]{4}$/);
    assert.ok(!/[0O1lI]/.test(password));
  }
});

test('выдача доступа: без роли — отказ; с ролью — логин, хэш, обязательная смена, сессии гаснут', t => {
  const db = freshDb(t);
  const id = hire(db, 'Дойкина Оксана');
  assert.match(issueAccess(db, id, { hashPassword }).error, /назначьте роль/);
  assignRoleSets(db, id, ['log_ctrl']);
  db.prepare(`INSERT INTO sessions(token_hash,user_id,expires_at) VALUES('old',?,'2099-01-01')`).run(id);
  const issued = issueAccess(db, id, { hashPassword });
  assert.ok(issued.ok);
  const row = userRow(db, id);
  assert.equal(row.username, 'doykina.o');
  assert.ok(verifyPassword(issued.password, row.password_hash));
  assert.ok(!row.password_hash.includes(issued.password));
  assert.equal(row.must_change_password, 1);
  assert.ok(canLogin(row));
  assert.equal(db.prepare('SELECT COUNT(*) c FROM sessions WHERE user_id=?').get(id).c, 0);
  // Сброс: логин тот же, пароль новый.
  const again = issueAccess(db, id, { hashPassword });
  assert.equal(again.username, 'doykina.o');
  assert.ok(again.reissue);
  assert.notEqual(again.password, issued.password);
});

test('массовая выдача: только действующим с ролью и без входа, админа не трогает', t => {
  const db = freshDb(t);
  const a = hire(db, 'Андреева Ольга'); assignRoleSets(db, a, ['log_ctrl']);
  const b = hire(db, 'Лётова Ирина'); assignRoleSets(db, b, ['log_ctrl']);
  hire(db, 'Щукарев Олег', 'st-p22'); // слесарь — без роли
  issueAccess(db, b, { hashPassword }); // у Лётовой уже есть вход
  const items = issueAccessBulk(db, { hashPassword });
  assert.deepEqual(items.map(item => item.fullName), ['Андреева Ольга']);
});

test('смена своего пароля: проверка текущего, правила, флаг снимается', t => {
  const db = freshDb(t);
  const id = hire(db, 'Кожаева Евгения');
  assignRoleSets(db, id, ['log_ctrl']);
  const { password, username } = issueAccess(db, id, { hashPassword });
  const user = userRow(db, id);
  const opts = { hashPassword, verifyPassword };
  assert.match(changeOwnPassword(db, user, { current: 'не тот', next: 'Новый-пароль-77' }, opts).error, /неверный/);
  assert.match(changeOwnPassword(db, user, { current: password, next: 'короткий1' }, opts).error, /10/);
  assert.match(changeOwnPassword(db, user, { current: password, next: 'толькобуквы' }, opts).error, /цифры/);
  assert.match(changeOwnPassword(db, user, { current: password, next: `${username}-2026x` }, opts).error, /логин/);
  assert.ok(changeOwnPassword(db, user, { current: password, next: 'Мой-пароль-2026' }, opts).ok);
  const row = userRow(db, id);
  assert.equal(row.must_change_password, 0);
  assert.ok(verifyPassword('Мой-пароль-2026', row.password_hash));
  assert.equal(passwordProblem('Хороший-пароль-1'), '');
});

test('гость: только чтение по набору, срок, вне штата и структуры; истёк — входа нет', t => {
  const db = freshDb(t);
  const before = structureData(db).totals.fact;
  assert.match(createGuest(db, { fullName: 'Аудитор', roleSet: 'log_head', until: '2000-01-01' }, { hashPassword }).error, /Срок/);
  assert.match(createGuest(db, { fullName: 'Аудитор', roleSet: 'admin', until: '2099-01-01' }, { hashPassword }).error, /администратор/i);
  const guest = createGuest(db, { fullName: 'Иванов Пётр', roleSet: 'log_head', until: '2099-12-31', note: 'аудит' }, { hashPassword });
  assert.ok(guest.ok, guest.error);
  assert.equal(guest.username, 'ivanov.p');
  const row = userRow(db, guest.id);
  assert.equal(row.guest, 1);
  assert.equal(row.must_change_password, 1);
  assert.equal(row.job_role, 'Гость · аудит');
  assert.ok(effectivePermissions(row).every(permission => permission.endsWith(':read')));
  assert.equal(accessOf(db, row).money, 'full');
  assert.equal(structureData(db).totals.fact, before, 'гость не в штате');
  assert.ok(!structureData(db).unplaced.some(item => item.id === guest.id));
  assert.equal(guestExpired(row, '2099-12-31'), false);
  assert.equal(guestExpired(row, '2100-01-01'), true);
  assert.ok(updateGuest(db, guest.id, { until: '2000-01-01' }).ok);
  assert.ok(guestExpired(userRow(db, guest.id)));
  assert.match(issueAccess(db, guest.id, { hashPassword }).error, /истёк/);
});

test('права должности: посев по утверждённой таблице; новая должность с набором; применение к людям', t => {
  const db = freshDb(t);
  assert.equal(positionById(db, 'st-p9').role_set, 'log_ctrl');
  assert.equal(positionById(db, 'st-p22').role_set, '', 'слесарь — без входа');
  // Набор чужого отдела к должности не привязывается.
  const groupLog = db.prepare(`SELECT id FROM org_groups WHERE dept_key='log' LIMIT 1`).get().id;
  assert.match(createPosition(db, { group: groupLog, title: 'Аналитик', roleSet: 'toir_mech' }).error, /другого отдела/);
  const made = createPosition(db, { group: groupLog, title: 'Аналитик', roleSet: 'log_plan', headcount: 1 });
  assert.ok(made.ok, made.error);
  assert.equal(positionById(db, made.id).role_set, 'log_plan');
  // Смена набора должности с галкой «применить к людям».
  const a = hire(db, 'Гаев Даниил', 'st-p9'); assignRoleSets(db, a, ['log_ctrl']);
  const result = updatePosition(db, 'st-p9', { roleSet: 'log_assign', applyToPeople: true });
  assert.equal(result.applied, 1);
  assert.deepEqual(JSON.parse(userRow(db, a).role_sets), ['log_assign']);
});

test('свой набор: на основе существующего, экраны и деньги, не выше своих; утверждённые не правятся', t => {
  const db = freshDb(t);
  assert.match(createRoleSet(db, { title: 'X', base: 'admin' }, { creatorMoney: 'full' }).error, /администратора/);
  assert.match(createRoleSet(db, { title: 'Аналитик', base: 'log_plan', money: 'full' }, { creatorMoney: 'rates' }).error, /выше/);
  const made = createRoleSet(db, { title: 'Аналитик логистики', base: 'log_plan', views: ['sales', 'routes', 'nonexistent'], money: 'none' },
    { creatorMoney: 'full' });
  assert.ok(made.ok, made.error);
  const set = roleSets(db).find(item => item.id === made.id);
  assert.deepEqual(set.views, ['sales', 'routes']);
  assert.equal(set.scope, 'log');
  assert.deepEqual(set.codes, ['sales', 'logist', 'dispatcher']); // логистика управляет рейсами целиком (11.11)
  assert.equal(set.money, 'none');
  assert.ok(updateRoleSet(db, made.id, { views: ['sales'] }, { creatorMoney: 'full' }).ok);
  assert.match(updateRoleSet(db, 'log_plan', { views: ['sales'] }, { creatorMoney: 'full' }).error, /Утверждённые/);
});

test('логин не по образцу (прежняя учётка прода) — при выдаче стандартный, как у всех; отделы без набора не трогаются', async t => {
  const db = freshDb(t);
  const { isStandardLogin } = await import('../src/credentials.mjs');
  assert.ok(isStandardLogin('tarasov.ea') && isStandardLogin('tokareva.v2') && isStandardLogin('admin'));
  assert.ok(!isStandardLogin('Тарасов Е') && !isStandardLogin('Planer') && !isStandardLogin('Логист 1'));
  const insert = (fullName, username, sets) => {
    const id = crypto.randomUUID();
    db.prepare(`INSERT INTO users(id,username,full_name,password_hash,role,roles,active) VALUES(?,?,?,?,?,?,1)`)
      .run(id, username, fullName, hashPassword('Old-password-2026'), 'mechanic', '["mechanic"]');
    if (sets) assignRoleSets(db, id, sets);
    return id;
  };
  const tarasov = insert('Тарасов Евгений Анатольевич', 'Тарасов Е', ['toir_head']);
  const logist = insert('Токарева Вера', 'Токарева В', null); // отдел не включён
  db.prepare(`INSERT INTO settings(key,value_json) VALUES('staff', ?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json`)
    .run(JSON.stringify({ fullAccess: 'Тарасов Е, nikulina' }));
  const items = issueAccessBulk(db, { hashPassword });
  assert.deepEqual(items.map(item => item.username), ['tarasov.ea']);
  assert.equal(items[0].renamedFrom, 'Тарасов Е');
  assert.equal(userRow(db, tarasov).must_change_password, 1);
  assert.equal(userRow(db, logist).username, 'Токарева В', 'Логистика не включена — не трогаем');
  assert.match(JSON.parse(db.prepare(`SELECT value_json FROM settings WHERE key='staff'`).get().value_json).fullAccess, /tarasov\.ea/);
  // Повторно — уже по образцу: в массовую не попадает, сброс сохраняет логин.
  assert.equal(issueAccessBulk(db, { hashPassword }).length, 0);
  assert.equal(issueAccess(db, tarasov, { hashPassword }).username, 'tarasov.ea');
});

test('доступ к затратам галкой: логин добавляется и убирается, прежние логины с пробелом целы', async t => {
  const db = freshDb(t);
  const { setExpensesAccess, expensesAccess } = await import('../src/expenses.mjs');
  const settings = () => ({ expenses: JSON.parse(db.prepare(`SELECT value_json FROM settings WHERE key='expenses'`).get()?.value_json || '{}') });
  const user = login => ({ username: login, roles: '["resource"]', role_sets: '["drv_head"]' });
  setExpensesAccess(db, 'Дарья Н', true);
  setExpensesAccess(db, 'tarasov.ea', true);
  setExpensesAccess(db, 'tarasov.ea', true); // повтор — без дубля
  assert.equal(settings().expenses.access, 'Дарья Н, tarasov.ea');
  assert.ok(expensesAccess(user('Дарья Н'), settings()) && expensesAccess(user('tarasov.ea'), settings()));
  setExpensesAccess(db, 'Дарья Н', false);
  assert.ok(!expensesAccess(user('Дарья Н'), settings()));
  assert.ok(expensesAccess(user('tarasov.ea'), settings()));
});
