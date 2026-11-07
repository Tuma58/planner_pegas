// АРМ «Моё рабочее место» (Э1, 07.11.2026): один каркас — четыре зоны,
// наполнение по реестру должности, пилот на четырёх наборах.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../src/db.mjs';
import { accessOf, assignRoleSets } from '../src/access.mjs';
import { ARM_ROLES, ARM_ZONES, addTask, armApi, armData, armRoleOf, canAssign, canView, driverArmData, driverTaskAction, peopleFor, taskAction } from '../src/arm.mjs';

function freshDb(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pegas-arm-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = openDatabase(path.join(directory, 'planner.db'), {
    username: 'root-admin', password: 'Temporary-password-2026', fullName: 'Администратор'
  });
  t.after(() => db.close());
  return db;
}
const userWith = (db, sets) => {
  const id = randomUUID();
  db.prepare(`INSERT INTO users(id,username,full_name,password_hash,role,active) VALUES(?,?,?,?,?,1)`)
    .run(id, `u-${id.slice(0, 6)}`, 'Тестов Тест', 'x', 'logist');
  assignRoleSets(db, id, sets);
  return db.prepare('SELECT * FROM users WHERE id=?').get(id);
};

test('пилот Э1: четыре должности, у каждой четыре зоны в одном порядке', t => {
  const db = freshDb(t);
  for (const role of ['drv_acc', 'log_assign', 'log_ctrl', 'toir_mech']) assert.ok(ARM_ROLES[role], role);
  assert.deepEqual(ARM_ZONES.map(([key]) => key), ['analysis', 'plan', 'exec', 'tasks']);
  for (const role of ['drv_acc', 'log_assign', 'log_ctrl', 'toir_mech']) {
    const user = userWith(db, [role]);
    const data = armData(db, user, role);
    assert.deepEqual(Object.keys(data.zones), ['analysis', 'plan', 'exec', 'tasks'], role);
    for (const items of Object.values(data.zones)) {
      for (const item of items) {
        assert.ok(['metric', 'row', 'task'].includes(item.kind), `${role}: ${item.label}`);
        assert.ok(item.label && item.source, `${role}: у виджета есть подпись и источник`);
      }
    }
    assert.ok(data.zones.plan.length && data.zones.exec.length, role);
    assert.equal(data.person.name, 'Тестов Тест');
  }
});

test('выполнение и задачи — из живых данных: ремзона и запрос выпуска у механика', t => {
  const db = freshDb(t);
  const user = userWith(db, ['toir_mech']);
  const vehicle = db.prepare('SELECT id, plate FROM vehicles LIMIT 1').get();
  const past = new Date(Date.now() - 3_600_000).toISOString();
  db.prepare(`INSERT INTO repair_orders(id,vehicle_id,status,purpose,planned_out) VALUES(?,?,?,?,?)`)
    .run(randomUUID(), vehicle.id, 'in_progress', 'плановый ремонт', past);
  db.prepare(`INSERT INTO remzona_release_requests(id,vehicle_id,note,requested_by_name) VALUES(?,?,?,?)`)
    .run(randomUUID(), vehicle.id, 'под рейс в Москву', 'Логистов');
  const data = armData(db, user, 'toir_mech');
  const late = data.zones.exec.find(item => item.label === 'Просрочен выпуск');
  assert.ok(late.value >= 1);
  assert.equal(late.tone, 'neg');
  const request = data.zones.tasks.find(item => item.label.includes(vehicle.plate));
  assert.ok(request && request.tag.includes('Логистов'));
});

test('API: каркас и данные набора; без входа — 401', async t => {
  const db = freshDb(t);
  assert.equal(armRoleOf(['log_head', 'log_ctrl']), 'log_head'); // первый набор человека
  assert.equal(armRoleOf(['log_head']), 'log_head');
  assert.equal(armRoleOf(['unknown']), null);
  const call = async (user, search = '') => {
    const out = {};
    const handled = await armApi({ db, request: { method: 'GET' }, response: {}, pathname: '/api/arm',
      url: new URL(`http://x/api/arm${search}`), user, access: user ? accessOf(db, user) : null, accessOf,
      settingsObject: () => ({}),
      json: (_r, status, body) => { out.status = status; out.body = body; },
      errorJson: (_r, status, error) => { out.status = status; out.body = { error }; } });
    return { handled, ...out };
  };
  assert.equal((await call(null)).status, 401);
  const head = await call(userWith(db, ['log_head']));
  assert.equal(head.body.pilot, true); // Э3: у руководителя тоже наполнено
  assert.deepEqual(Object.keys(head.body.zones), ['analysis', 'plan', 'exec', 'tasks']);
  const ctrl = await call(userWith(db, ['log_ctrl']));
  assert.equal(ctrl.body.pilot, true);
  assert.equal(ctrl.body.role, 'log_ctrl');
  assert.equal(await armApi({ pathname: '/api/other' }), false);
});

test('экран АРМ — у пилотных наборов первым', t => {
  const db = freshDb(t);
  for (const role of ['drv_acc', 'log_assign', 'log_ctrl', 'toir_mech']) {
    const access = accessOf(db, userWith(db, [role]));
    assert.equal(access.views[0], 'arm', role);
  }
});

const placed = (db, sets, n) => {
  const user = userWith(db, sets);
  const pos = db.prepare('SELECT id FROM org_positions WHERE n=?').get(n);
  db.prepare('UPDATE users SET position_id=? WHERE id=?').run(pos.id, user.id);
  return db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
};

test('Э2: задачи ставят в своём отделе (руководитель и коллеги), направление — всем; между отделами — нет', t => {
  const db = freshDb(t);
  const logHead = placed(db, ['log_head'], 5);
  const logist = placed(db, ['log_assign'], 7);
  const ctrl = placed(db, ['log_ctrl'], 8);
  const mech = placed(db, ['toir_mech'], 16);
  const dir = placed(db, ['dir_head'], 1);
  const acc = user => accessOf(db, user);
  assert.ok(canAssign(db, logHead, acc(logHead), logist));
  assert.ok(canAssign(db, logist, acc(logist), ctrl)); // коллега коллеге
  assert.ok(!canAssign(db, logist, acc(logist), mech)); // чужой отдел
  assert.ok(canAssign(db, dir, acc(dir), mech));
  assert.ok(!canAssign(db, logist, acc(logist), logist)); // себе — нет
  // Смотреть место: руководитель — своих, коллега — нет.
  assert.ok(canView(db, logHead, acc(logHead), logist));
  assert.ok(!canView(db, logist, acc(logist), ctrl));
  assert.ok(!canView(db, logHead, acc(logHead), mech));
  assert.ok(canView(db, dir, acc(dir), mech));
  const due = new Date(Date.now() + 86_400_000).toISOString();
  assert.equal(addTask(db, logist, acc(logist), { toUserId: mech.id, title: 'x', dueAt: due }).status, 403);
  assert.equal(addTask(db, logist, acc(logist), { toUserId: ctrl.id, title: '', dueAt: due }).status, 422);
  assert.equal(addTask(db, logist, acc(logist), { toUserId: ctrl.id, title: 'Проверить наличные', dueAt: '' }).status, 422);
  const created = addTask(db, logist, acc(logist), { toUserId: ctrl.id, title: 'Проверить наличные', dueAt: due, about: 'рейс 123' });
  assert.ok(created.ok);
  // В АРМ исполнителя — с действиями; у автора — «Я поставил».
  const forCtrl = armData(db, ctrl, 'log_ctrl');
  const item = forCtrl.zones.tasks.find(row => row.id === created.id);
  assert.deepEqual(item.actions, ['take', 'done', 'fail']);
  assert.equal(armData(db, logist, 'log_assign').given[0].id, created.id);
  // Только просмотр «глазами сотрудника» — без действий.
  assert.deepEqual(armData(db, ctrl, 'log_ctrl', { readOnly: true }).zones.tasks.find(row => row.id === created.id).actions, []);
  // Действия: чужой не отмечает, «не сделано» — с причиной, снять — только автор.
  assert.equal(taskAction(db, logist, created.id, 'done').status, 403);
  assert.ok(taskAction(db, ctrl, created.id, 'take').ok);
  assert.equal(taskAction(db, ctrl, created.id, 'fail', '').status, 422);
  assert.equal(taskAction(db, ctrl, created.id, 'cancel').status, 403);
  const done = taskAction(db, ctrl, created.id, 'done', 'сверено');
  assert.equal(done.notify, logist.id); // автору — уведомление
  assert.equal(taskAction(db, ctrl, created.id, 'done').status, 409);
  const onTime = armData(db, ctrl, 'log_ctrl').zones.analysis.find(row => row.label.startsWith('Задачи в срок'));
  assert.equal(onTime.value, 100);
});

test('Э3: АРМ у всех наборов ролей — четыре зоны, у каждого виджета подпись и источник', t => {
  const db = freshDb(t);
  const sets = db.prepare('SELECT id FROM role_sets').all().map(row => row.id);
  const parkStub = () => ({ total: { ktg: 96, kvl: 92, kip: 80, koef: 70.7, rev: 41_500_000, trips: 300 } });
  for (const role of sets) {
    assert.ok(ARM_ROLES[role], `в реестре нет набора ${role}`);
    const user = userWith(db, [role === 'admin' ? 'dir_head' : role]);
    const data = armData(db, user, role, { park: parkStub, money: 'full' });
    for (const [zone, items] of Object.entries(data.zones)) {
      for (const item of items) assert.ok(item.label && item.source, `${role}/${zone}: ${JSON.stringify(item)}`);
    }
    const filled = ['analysis', 'plan', 'exec'].filter(zone => data.zones[zone].length).length;
    assert.ok(filled >= 2, `${role}: наполнено зон ${filled}`);
  }
  // Коэффициент — из канона и против цели Настроек; выручка — только при деньгах «все».
  const dir = armData(db, userWith(db, ['dir_head']), 'dir_head', { park: parkStub, money: 'full' });
  assert.equal(dir.zones.analysis.find(item => item.label.startsWith('КТГ')).value, 96);
  assert.ok(dir.zones.analysis.some(item => item.label.startsWith('Выручка')));
  const noMoney = armData(db, userWith(db, ['drv_head']), 'log_head', { park: parkStub, money: 'none' });
  assert.ok(!noMoney.zones.analysis.some(item => item.label.startsWith('Выручка')));
});

test('Э4: у руководителей отделов поле внутри АРМ — без дублей виджетов поля', t => {
  const db = freshDb(t);
  for (const [role, dept] of [['log_head', 'log'], ['drv_head', 'drv'], ['toir_head', 'toir']]) {
    const data = armData(db, userWith(db, [role]), role);
    assert.equal(data.fieldDept, dept, role);
    // Коэффициент, очереди и стыки отдела приходят секциями поля, не виджетами АРМ.
    assert.ok(!data.zones.analysis.some(item => /^(КТГ|КВЛ|КИП)/.test(item.label)), role);
    assert.ok(!data.zones.tasks.some(item => item.source === 'joint_signals'), role);
  }
  assert.equal(armData(db, userWith(db, ['dir_head']), 'dir_head').fieldDept, null); // поле направления — панель Штаба
  // Задачи смены по процессу — ссылкой на панель рабочего экрана.
  const logist = armData(db, userWith(db, ['log_assign']), 'log_assign');
  assert.ok(logist.zones.tasks.some(item => item.source === 'task_marks' && item.screen === 'logist'));
});

test('Э5: АРМ водителя — тот же каркас; задачу ставит Эксплуатация, водитель закрывает из приложения', t => {
  const db = freshDb(t);
  const driver = db.prepare(`SELECT * FROM drivers WHERE status<>'fired' AND vehicle_id IS NOT NULL LIMIT 1`).get();
  const data = driverArmData(db, driver);
  assert.deepEqual(Object.keys(data.zones), ['analysis', 'plan', 'exec', 'tasks']);
  assert.ok(data.zones.analysis.length >= 1);
  assert.equal(data.person.name, driver.full_name);
  const acc = user => accessOf(db, user);
  const column = placed(db, ['drv_column'], 10);
  const logist = placed(db, ['log_assign'], 7);
  assert.ok(peopleFor(db, column, acc(column)).some(person => person.id === `d:${driver.id}`));
  assert.ok(!peopleFor(db, logist, acc(logist)).some(person => person.driver)); // логистика водителям не ставит
  const due = new Date(Date.now() + 86_400_000).toISOString();
  assert.equal(addTask(db, logist, acc(logist), { toUserId: `d:${driver.id}`, title: 'x', dueAt: due }).status, 403);
  const created = addTask(db, column, acc(column), { toUserId: `d:${driver.id}`, title: 'Пройти инструктаж', dueAt: due });
  assert.ok(created.ok && created.driver.id === driver.id);
  const task = driverArmData(db, driver).zones.tasks.find(item => item.id === created.id);
  assert.deepEqual(task.actions, ['take', 'done', 'fail']);
  // Чужой водитель не видит и не закрывает.
  const other = db.prepare(`SELECT * FROM drivers WHERE id<>? AND status<>'fired' LIMIT 1`).get(driver.id);
  assert.equal(driverTaskAction(db, other, created.id, 'done').status, 404);
  assert.equal(driverTaskAction(db, driver, created.id, 'fail', '').status, 422);
  const done = driverTaskAction(db, driver, created.id, 'done', 'прошёл');
  assert.ok(done.ok);
  assert.equal(done.notify, column.id); // начальнику колонны — уведомление
  assert.equal(db.prepare('SELECT status FROM arm_tasks WHERE id=?').get(created.id).status, 'done');
  // Задача водителю видна у автора в «Я поставил» до закрытия, а снимает её только автор.
  const second = addTask(db, column, acc(column), { toUserId: `d:${driver.id}`, title: 'Сдать путевой', dueAt: due });
  assert.equal(armData(db, column, 'drv_column').given[0].id, second.id);
  assert.equal(driverTaskAction(db, driver, second.id, 'cancel').status, 403);
  assert.ok(taskAction(db, column, second.id, 'cancel').ok);
});

test('чек-лист 07.11: снабжение — без выручки рейсов, но с ценами склада', async t => {
  const db = freshDb(t);
  const { partsRights } = await import('../src/parts.mjs');
  const { hasPermission } = await import('../src/permissions.mjs');
  const supply = userWith(db, ['toir_supply']);
  const access = accessOf(db, supply);
  assert.equal(access.money, 'none');
  assert.equal(partsRights({ user: supply, access, hasPermission }).money, true);
  const mech = userWith(db, ['toir_mech']);
  assert.equal(partsRights({ user: mech, access: accessOf(db, mech), hasPermission }).money, false);
});
