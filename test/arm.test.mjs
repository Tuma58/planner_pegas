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
import { ARM_ROLES, ARM_ZONES, armApi, armData, armRoleOf } from '../src/arm.mjs';

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
  assert.deepEqual(Object.keys(ARM_ROLES).sort(), ['drv_acc', 'log_assign', 'log_ctrl', 'toir_mech']);
  assert.deepEqual(ARM_ZONES.map(([key]) => key), ['analysis', 'plan', 'exec', 'tasks']);
  for (const role of Object.keys(ARM_ROLES)) {
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

test('набор без АРМ и старая модель — pilot:false; набор из реестра — данные', t => {
  const db = freshDb(t);
  assert.equal(armRoleOf(['log_head', 'log_ctrl']), 'log_ctrl');
  assert.equal(armRoleOf(['log_head']), null);
  const call = user => {
    const out = {};
    const handled = armApi({ db, request: { method: 'GET' }, response: {}, pathname: '/api/arm', user,
      access: user ? accessOf(db, user) : null, settingsObject: () => ({}),
      json: (_r, status, body) => { out.status = status; out.body = body; },
      errorJson: (_r, status, error) => { out.status = status; out.body = { error }; } });
    return { handled, ...out };
  };
  assert.equal(call(null).status, 401);
  assert.equal(call(userWith(db, ['log_head'])).body.pilot, false);
  const ctrl = call(userWith(db, ['log_ctrl']));
  assert.equal(ctrl.body.pilot, true);
  assert.equal(ctrl.body.role, 'log_ctrl');
  const other = armApi({ pathname: '/api/other' });
  assert.equal(other, false);
});

test('экран АРМ — у пилотных наборов первым', t => {
  const db = freshDb(t);
  for (const role of Object.keys(ARM_ROLES)) {
    const access = accessOf(db, userWith(db, [role]));
    assert.equal(access.views[0], 'arm', role);
  }
});
