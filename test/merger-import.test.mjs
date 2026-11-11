// Перенос «Слияния» по отделам (10.11.2026): сопоставление ФИО с
// короткими именами прода, включение отдела, откат к прежним правам.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../src/db.mjs';
import { accessOf } from '../src/access.mjs';
import { applyMerger, loadSnapshot, mergerPlan, nameMatch, rollbackMerger } from '../src/merger-import.mjs';

function freshDb(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pegas-merger-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = openDatabase(path.join(directory, 'planner.db'), {
    username: 'root-admin', password: 'Temporary-password-2026', fullName: 'Администратор'
  });
  t.after(() => db.close());
  return db;
}
const prodUser = (db, fullName, username, roles) => {
  const id = randomUUID();
  db.prepare(`INSERT INTO users(id,username,full_name,password_hash,role,roles,active) VALUES(?,?,?,?,?,?,1)`)
    .run(id, username, fullName, 'scrypt$x', roles[0], JSON.stringify(roles));
  return id;
};

test('ФИО: короткие имена прода находят людей табеля', () => {
  assert.equal(nameMatch('Токарева Вера', 'Токарева В'), 'exact');
  assert.equal(nameMatch('Базуев Лев', 'Лев Базуев'), 'exact');
  assert.equal(nameMatch('Никулина Дарья', 'Дарья Н'), 'exact');
  assert.equal(nameMatch('Филюнина Оксана', 'Filyunina O'), 'exact');
  assert.equal(nameMatch('Киселёва Лариса', 'Kiseleva L'), 'exact');
  assert.equal(nameMatch('Тарасов Евгений Анатольевич', 'Тарасов Е'), 'exact');
  assert.equal(nameMatch('Петров Глеб', 'Петров Глеб'), 'exact');
  assert.equal(nameMatch('Вахрамеева Мария', 'Вахромеева М'), 'close');
  assert.equal(nameMatch('Токарева Вера', 'Токалова А'), null);
  assert.equal(nameMatch('Тарасов Евгений', 'Тарасов П'), null);
});

test('ТОиР: план, включение, откат; прочие отделы не тронуты', t => {
  const db = freshDb(t);
  const snapshot = loadSnapshot();
  const tarasov = prodUser(db, 'Тарасов Е', 'Тарасов Е', ['logist', 'resource', 'dispatcher']);
  const tokareva = prodUser(db, 'Токарева В', 'Токарева В', ['logist', 'resource', 'dispatcher', 'sales']);
  const plan = mergerPlan(db, 'toir', { snapshot });
  const tarasovRow = plan.rows.find(row => row.fullName.startsWith('Тарасов'));
  assert.equal(tarasovRow.prod.id, tarasov);
  assert.equal(tarasovRow.action, 'update');
  assert.ok(plan.rows.every(row => row.action !== 'fire'), 'уволенных ТОиР на проде нет');
  assert.ok(plan.summary.create > 10);
  const result = applyMerger(db, 'toir', { snapshot, by: 'тест' });
  assert.ok(result.ok, result.error);
  const after = db.prepare('SELECT * FROM users WHERE id=?').get(tarasov);
  assert.deepEqual(accessOf(db, after).sets, ['toir_head']);
  assert.equal(accessOf(db, db.prepare('SELECT * FROM users WHERE id=?').get(tokareva)).legacy, true, 'Логистика по-старому');
  // Повторный прогон — без дублей.
  const again = mergerPlan(db, 'toir', { snapshot });
  assert.equal(again.summary.create, 0);
  // Откат: Тарасову вернулись прежние права, созданные — без входа.
  assert.ok(rollbackMerger(db, 'toir').ok);
  const back = db.prepare('SELECT * FROM users WHERE id=?').get(tarasov);
  assert.deepEqual(JSON.parse(back.roles), ['logist', 'resource', 'dispatcher']);
  assert.equal(accessOf(db, back).legacy, true);
  const created = db.prepare(`SELECT COUNT(*) n FROM users WHERE role_sets<>'' AND full_name<>'Тарасов Е'`).get().n;
  assert.equal(created, 0);
});

test('неоднозначное сопоставление блокирует включение до ручного выбора', t => {
  const db = freshDb(t);
  const snapshot = loadSnapshot();
  prodUser(db, 'Тарасов Е', 'tarasov1', ['mechanic']);
  const second = prodUser(db, 'Тарасов Евгений', 'tarasov2', ['mechanic']);
  const blocked = applyMerger(db, 'toir', { snapshot });
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /Тарасов/);
  const name = snapshot.users.find(user => user.fullName.startsWith('Тарасов')).fullName;
  assert.ok(applyMerger(db, 'toir', { snapshot, overrides: { [name]: second } }).ok);
});

test('учётка прода без набора не получает новое право «Выпуск»; с набором Эксплуатации — получает', async () => {
  const { effectivePermissions } = await import('../src/permissions.mjs');
  const legacy = { roles: JSON.stringify(['logist', 'resource', 'dispatcher']), role_sets: '' };
  assert.ok(!effectivePermissions(legacy).includes('release:write'));
  assert.ok(effectivePermissions(legacy).includes('fleet:write'), 'прежние права целы');
  assert.ok(effectivePermissions({ roles: '["resource"]', role_sets: '["drv_head"]' }).includes('release:write'));
  assert.ok(effectivePermissions({ roles: '["admin"]', role_sets: '' }).includes('release:write'));
  assert.ok(effectivePermissions({ roles: '["techctl"]', role_sets: '' }).includes('release:write'));
});

test('полный доступ к справочнику: логин с пробелом («Дарья Н») понимается, прежние списки через пробел тоже', async () => {
  const { staffAccess } = await import('../src/staff.mjs');
  const user = { username: 'Дарья Н', roles: '["resource"]', role_sets: '["drv_head"]' };
  assert.ok(staffAccess(user, { staff: { fullAccess: 'Дарья Н' } }));
  assert.ok(staffAccess(user, { staff: { fullAccess: 'tokareva.v, Дарья Н' } }));
  assert.ok(staffAccess({ username: 'nikulina', roles: '[]' }, { staff: { fullAccess: 'tokareva nikulina' } }));
  assert.ok(!staffAccess({ username: 'Н', roles: '[]' }, { staff: { fullAccess: 'Дарья Н' } }), 'кусок логина — не логин');
  assert.ok(!staffAccess({ username: 'Дарья', roles: '[]' }, { staff: { fullAccess: 'Дарья Н' } }));
});
