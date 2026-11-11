// Чистота графика (ревизия 11.11, кейс х041хх58): единый резолвер ФИО
// в карте держателей, сторож «двое держат борт», сторож дубль-строк,
// чистка будущего плана уволенных при материализации.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/db.mjs';
import { applyScheduleSync, projectPlanToTable, scheduleConflicts,
  scheduleHolderMap, syncAssignBridge } from '../src/schedule.mjs';

const freshDb = t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pegas-dup-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = openDatabase(path.join(directory, 'planner.db'), {
    username: 'root-admin', password: 'Temporary-password-2026', fullName: 'Администратор'
  });
  t.after(() => db.close());
  return db;
};

// План-ленты по дням горизонта (сегодня+from … сегодня+to включительно).
const planFor = (code, from, to) => {
  const plan = {};
  for (let i = from; i <= to; i += 1) {
    const iso = new Date(Date.now() + i * 86_400_000).toISOString().slice(0, 10);
    const mk = iso.slice(0, 7);
    if (!plan[mk]) {
      const days = new Date(Number(mk.slice(0, 4)), Number(mk.slice(5, 7)), 0).getDate();
      plan[mk] = Array(days).fill('');
    }
    plan[mk][Number(iso.slice(8, 10)) - 1] = code;
  }
  return plan;
};

test('график: дубль-строка одного человека не делает «двоих», сторож её называет', t => {
  const db = freshDb(t);
  const type = db.prepare('SELECT id FROM vehicle_types LIMIT 1').get().id;
  db.prepare(`INSERT INTO vehicles(id,plate,type_id,status) VALUES('v892','х041хх58',?,'work')`).run(type);
  db.prepare(`INSERT INTO drivers(id,full_name,status) VALUES('d-tug','Тугаев Ильяс Равилевич','active')`).run();
  // Один человек двумя строками: полное ФИО и короткое (как в кейсе).
  const crew = { id: 'E003', ts: [{ id: 'T1', tyagach: 'х041хх58' }],
    drv: [
      { id: 'D1', fio: 'Тугаев Ильяс Равилевич', ts: 'T1', vac: false, plan: planFor('в', 1, 4), fact: {} },
      { id: 'D2', fio: 'Тугаев Ильяс', ts: 'T1', vac: false, plan: planFor('в', 1, 4), fact: {} }
    ] };
  applyScheduleSync(db, { since: 0, crews: { E003: crew }, log: [] });
  const map = scheduleHolderMap(db);
  const day = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
  // Обе строки резолвятся в одного водителя — держатель однозначен.
  assert.equal(map.holder.get('v892|' + day), 'd-tug');
  const bridge = syncAssignBridge(db);
  assert.ok(bridge.made >= 1, 'мост закрепил борт, а не пропустил день как конфликт');
  // Сторож дубль-строк называет пару.
  const conflicts = scheduleConflicts(db);
  assert.equal(conflicts.doubleHolders.length, 0);
  assert.equal(conflicts.dupRows.length, 1);
  assert.match(conflicts.dupRows[0].driver, /Тугаев Ильяс Равилевич/);
  assert.equal(conflicts.dupRows[0].rows.length, 2);
});

test('график: два разных водителя на борту — сторож «двое держат» с именами и кодами', t => {
  const db = freshDb(t);
  const type = db.prepare('SELECT id FROM vehicle_types LIMIT 1').get().id;
  db.prepare(`INSERT INTO vehicles(id,plate,type_id,status) VALUES('v892','х041хх58',?,'work')`).run(type);
  db.prepare(`INSERT INTO vehicles(id,plate,type_id,status) VALUES('v459','х042хх58',?,'work')`).run(type);
  db.prepare(`INSERT INTO drivers(id,full_name,status) VALUES('d-kv','Кветнев Олег Марьянович','active')`).run();
  db.prepare(`INSERT INTO drivers(id,full_name,status) VALUES('d-tu','Тугаев Ильяс Равилевич','active')`).run();
  // Кветнев держит свой борт [в], Тугаев с р459 замещает его же кодом 041.
  const crew = { id: 'E003', ts: [{ id: 'T1', tyagach: 'х041хх58' }, { id: 'T2', tyagach: 'х042хх58' }],
    drv: [
      { id: 'D1', fio: 'Кветнев Олег Марьянович', ts: 'T1', vac: false, plan: planFor('в', 1, 3), fact: {} },
      { id: 'D2', fio: 'Тугаев Ильяс Равилевич', ts: 'T2', vac: false, plan: planFor('041', 1, 3), fact: {} }
    ] };
  applyScheduleSync(db, { since: 0, crews: { E003: crew }, log: [] });
  const map = scheduleHolderMap(db);
  const day = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
  assert.equal(map.holder.get('v892|' + day), map.MANY, 'конфликтный день помечен «двое»');
  const conflicts = scheduleConflicts(db);
  assert.equal(conflicts.doubleHolders.length, 1);
  const g = conflicts.doubleHolders[0];
  assert.equal(g.plate, 'х041хх58');
  assert.match(g.names, /Кветнев Олег Марьянович \[в\]/);
  assert.match(g.names, /Тугаев Ильяс Равилевич \[041\]/);
  assert.equal(g.days.length, 3);
  assert.equal(conflicts.dupRows.length, 0);
});

test('материализация: будущий план уволенного вычищается, история остаётся', t => {
  const db = freshDb(t);
  const type = db.prepare('SELECT id FROM vehicle_types LIMIT 1').get().id;
  db.prepare(`INSERT INTO vehicles(id,plate,type_id,status) VALUES('v1','х913хх58',?,'work')`).run(type);
  db.prepare(`INSERT INTO drivers(id,full_name,status) VALUES('d-fired','Янбарисов Эльдар','fired')`).run();
  db.prepare(`INSERT INTO drivers(id,full_name,status) VALUES('d-live','Янбарисов Эльдар Ряшитович','active')`).run();
  const past = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
  const future = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
  for (const day of [past, future]) db.prepare(`INSERT INTO driver_plan_days(driver_id,day,code,vehicle_id)
    VALUES('d-fired',?,'в','v1')`).run(day);
  const crew = { id: 'E005', ts: [{ id: 'T1', tyagach: 'х913хх58' }],
    drv: [{ id: 'D1', fio: 'Янбарисов Эльдар Ряшитович', ts: 'T1', vac: false,
      plan: planFor('в', 1, 2), fact: {} }] };
  applyScheduleSync(db, { since: 0, crews: { E005: crew }, log: [] });
  projectPlanToTable(db);
  const left = db.prepare(`SELECT day FROM driver_plan_days WHERE driver_id='d-fired' ORDER BY day`).all();
  assert.deepEqual(left.map(r => r.day), [past], 'будущее уволенного удалено, история цела');
});
