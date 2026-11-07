// «Моё поле» — поле управления отдела (Э1, 07.11.2026).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/db.mjs';
import { directionData, fieldData, fieldLive, idleVehicles } from '../src/field.mjs';
import { accessOf, assignRoleSets, roleSets } from '../src/access.mjs';

function freshDb(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pegas-field-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = openDatabase(path.join(directory, 'planner.db'), {
    username: 'root-admin', password: 'Temporary-password-2026', fullName: 'Администратор'
  });
  t.after(() => db.close());
  return db;
}

test('«Моё поле» есть в наборах руководителей и нет у рядовых ролей', t => {
  const db = freshDb(t);
  const views = new Map(roleSets(db).map(set => [set.id, set.views]));
  for (const id of ['dir_head', 'log_head', 'drv_head', 'toir_head', 'admin']) {
    assert.ok(views.get(id).includes('field'), id);
  }
  for (const id of ['drv_column', 'log_plan', 'log_assign', 'log_ctrl', 'drv_acc', 'toir_mech', 'accountant']) {
    assert.ok(!views.get(id).includes('field'), id);
  }
});

test('стыки и очереди: свободные без задания, из ремонта без водителя', t => {
  const db = freshDb(t);
  const vehicles = db.prepare(`SELECT id FROM vehicles WHERE status='work' LIMIT 2`).all();
  assert.equal(vehicles.length, 2);
  const now = new Date();
  const iso = ms => new Date(now.getTime() + ms).toISOString();
  // Первая машина — без водителя сразу после выпуска из ремонта.
  db.prepare(`INSERT INTO vehicle_dispositions(id,vehicle_id,kind,starts_at,ends_at) VALUES(?,?,?,?,?)`)
    .run('d1', vehicles[0].id, 'no_driver', iso(-3 * 3.6e6), iso(24 * 3.6e6));
  db.prepare(`INSERT INTO repair_orders(id,vehicle_id,status,purpose,released_at) VALUES(?,?,?,?,?)`)
    .run('r1', vehicles[0].id, 'released', 'ТО', iso(-4 * 3.6e6));
  const idle = idleVehicles(db);
  assert.ok(!idle.some(item => item.plate === db.prepare('SELECT plate FROM vehicles WHERE id=?').get(vehicles[0].id).plate));
  const drv = fieldLive(db, 'drv');
  const inbound = drv.joints.find(joint => joint.key === 'toir_drv');
  assert.equal(inbound.side, 'in');
  assert.equal(inbound.count, 1);
  assert.equal(drv.queues.find(queue => queue.key === 'no_driver').count, 1);
  const toir = fieldLive(db, 'toir');
  assert.equal(toir.joints.find(joint => joint.key === 'toir_drv').side, 'out');
  assert.equal(toir.joints.find(joint => joint.key === 'log_toir').count, null); // ждёт «Процессы и контроль»
  assert.ok(!toir.queues.some(queue => queue.dept === 'log')); // чужих очередей нет
});

test('сборка поля: коэффициент отдела, потери его этапа, только свои задачи', () => {
  const data = fieldData({
    dept: 'drv', month: '2026-07', from: '2026-07-01', to: '2026-08-01',
    park: { total: { ktg: 96, kvl: 92.5, kip: 80, koef: 71 }, weeks: [{ from: '2026-07-06', kvl: 91 }] },
    snap: { utilization: { calendarDays: 300, machineDays: { work: 200, repair: 10, noDriver: 7, shift: 3, idle: 80, out: 0 } } },
    goals: { items: [{ dept: 'drv', kind: 'task', title: 'Выпуск' }, { dept: 'log', kind: 'task', title: 'чужая' }],
      summary: { ok: 1, near: 0, miss: 0, info: 0, none: 0 }, initiatives: { drv: { p160: 2, eff: 1 } } },
    structure: null, cfo: null, live: { joints: [], queues: [] }, shifts: [],
    targets: { КВЛ: 99 }
  });
  assert.equal(data.coef.value, 92.5);
  assert.equal(data.coef.target, 99);
  assert.equal(data.machineDays.lost, 10);
  assert.deepEqual(data.tasks.map(task => task.title), ['Выпуск']);
  assert.deepEqual(data.initiatives, { p160: 2, eff: 1 });
});

test('руководитель отдела не может открыть поле чужого отдела через область', t => {
  const db = freshDb(t);
  const id = db.prepare(`SELECT id FROM users WHERE username='root-admin'`).get().id;
  assert.ok(assignRoleSets(db, id, ['drv_head'], { allowAdmin: true }).ok);
  const access = accessOf(db, db.prepare('SELECT * FROM users WHERE id=?').get(id));
  assert.deepEqual(access.scope.depts, ['drv']);
  assert.equal(access.scope.all, false);
});

test('поле направления: каскад против целей, водопад машино-дней по зонам, карточки трёх отделов', () => {
  const live = { joints: [], queues: [] };
  const data = directionData({
    month: '2026-07', from: '2026-07-01', to: '2026-08-01',
    park: { total: { ktg: 96, kvl: 92, kip: 80, koef: 70.7 }, weeks: [] },
    snap: { utilization: { calendarDays: 300, machineDays: { work: 200, repair: 10, noDriver: 7, shift: 3, idle: 80, out: 0 } } },
    goals: { items: [{ dept: 'staff', kind: 'task', title: 'Свод', metric: { tone: 'ok' } }], head: [], initiatives: { log: { p160: 1, eff: 0 } } },
    structure: null, cfo: null, targets: { КТГ: 97, КВЛ: 99, КИП: 99, КЭИП: 95.1 }
  }, { log: live, drv: live, toir: live, staff: { joints: [], queues: [] } });
  assert.equal(data.direction, true);
  assert.deepEqual(data.cascade.map(item => item.coef), ['КТГ', 'КВЛ', 'КИП', 'КЭИП']);
  assert.equal(data.cascade[3].target, 95.1);
  const step = key => data.waterfall.find(item => item.key === key);
  assert.equal(step('calendar').value, 300);
  assert.equal(step('noDriver').value, -10);
  assert.equal(step('noDriver').dept, 'drv');
  assert.equal(step('idle').dept, 'log');
  assert.equal(step('work').value, 200);
  assert.deepEqual(data.depts.map(card => card.dept), ['log', 'drv', 'toir']);
  assert.equal(data.depts.find(card => card.dept === 'toir').machineDays.lost, 10);
  assert.equal(data.staff.summary.ok, 1);
  assert.equal(data.joints.length, 3);
});
