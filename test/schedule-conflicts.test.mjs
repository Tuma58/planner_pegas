// Чистота графика (ревизия 11.11, кейс х041хх58): единый резолвер ФИО
// в карте держателей, сторож «двое держат борт», сторож дубль-строк,
// чистка будущего плана уволенных при материализации.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/db.mjs';
import { applyScheduleSync, muteFiredInSchedule, projectPlanToTable, scheduleConflicts,
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

test('сверка диспозиций: стоянка при рабочем коде и пересменка без «П»', t => {
  const db = freshDb(t);
  const type = db.prepare('SELECT id FROM vehicle_types LIMIT 1').get().id;
  db.prepare(`INSERT INTO vehicles(id,plate,type_id,status) VALUES('v1','х043хх58',?,'work')`).run(type);
  db.prepare(`INSERT INTO vehicles(id,plate,type_id,status) VALUES('v2','х044хх58',?,'work')`).run(type);
  db.prepare(`INSERT INTO drivers(id,full_name,status) VALUES('d1','Проверочный Пётр Петрович','active')`).run();
  db.prepare(`INSERT INTO drivers(id,full_name,status) VALUES('d2','Сменщиков Семён Семёнович','active')`).run();
  const crew = { id: 'E099', ts: [{ id: 'T1', tyagach: 'х043хх58' }, { id: 'T2', tyagach: 'х044хх58' }],
    drv: [
      { id: 'D1', fio: 'Проверочный Пётр Петрович', ts: 'T1', vac: false, plan: planFor('в', 1, 3), fact: {} },
      { id: 'D2', fio: 'Сменщиков Семён Семёнович', ts: 'T2', vac: false, plan: planFor('в', 1, 3), fact: {} }
    ] };
  applyScheduleSync(db, { since: 0, crews: { E099: crew }, log: [] });
  const dayIso = n => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
  // Ремонт на завтра-послезавтра при рабочем коде держателя.
  db.prepare(`INSERT INTO vehicle_dispositions(id,vehicle_id,kind,starts_at,ends_at)
    VALUES('dp1','v1','repair',?,?)`).run(dayIso(1) + 'T00:00:00.000Z', dayIso(3) + 'T00:00:00.000Z');
  // Пересменка руками в ганте: в плане дня «в», кода «П» нет.
  db.prepare(`INSERT INTO vehicle_dispositions(id,vehicle_id,kind,starts_at,ends_at)
    VALUES('dp2','v2','shift',?,?)`).run(dayIso(2) + 'T08:00:00.000Z', dayIso(2) + 'T12:00:00.000Z');
  const conflicts = scheduleConflicts(db);
  assert.equal(conflicts.dispoWork.length, 1);
  assert.equal(conflicts.dispoWork[0].plate, 'х043хх58');
  assert.match(conflicts.dispoWork[0].kind, /ремонт/);
  assert.match(conflicts.dispoWork[0].driver, /Проверочный/);
  assert.equal(conflicts.dispoWork[0].days.length, 2);
  assert.equal(conflicts.shiftNoP.length, 1);
  assert.equal(conflicts.shiftNoP[0].plate, 'х044хх58');
  // Код «П» в плане дня пересменки — расхождения нет (мостовая пересменка).
  crew.drv[1].plan = planFor('в', 1, 3);
  const mk = dayIso(2).slice(0, 7);
  crew.drv[1].plan[mk][Number(dayIso(2).slice(8)) - 1] = 'П';
  applyScheduleSync(db, { since: 1, crews: { E099: crew }, log: [] });
  const after = scheduleConflicts(db);
  assert.equal(after.shiftNoP.length, 0);
});

test('уволенные глушатся в графике: fired-метка, отвязка от сцепки, будущее пусто, история цела', t => {
  const db = freshDb(t);
  db.prepare(`INSERT INTO drivers(id, full_name, status) VALUES('d-f', 'Ушедший Иван Иванович', 'fired')`).run();
  db.prepare(`INSERT INTO drivers(id, full_name, status) VALUES('d-a', 'Оставшийся Пётр Петрович', 'active')`).run();
  const today = new Date().toISOString().slice(0, 10);
  const mk = today.slice(0, 7);
  const day = Number(today.slice(8, 10));
  const days = new Date(Number(mk.slice(0, 4)), Number(mk.slice(5, 7)), 0).getDate();
  const plan = { [mk]: Array(days).fill('р') };
  applyScheduleSync(db, { crews: { E900: { id: 'E900',
    ts: [{ id: 'T1', tyagach: 'т900тт58', crew: 'E900' }],
    drv: [
      { id: 'D1', fio: 'Ушедший Иван Иванович', crew: 'E900', ts: 'T1', plan: JSON.parse(JSON.stringify(plan)) },
      { id: 'D2', fio: 'Оставшийся Пётр Петрович', crew: 'E900', ts: '', plan: JSON.parse(JSON.stringify(plan)) }
    ] } } });
  const { muted } = muteFiredInSchedule(db);
  assert.equal(muted, 1);
  const body = JSON.parse(db.prepare(`SELECT body FROM schedule_crews WHERE id='E900'`).get().body);
  const gone = body.drv.find(d => d.id === 'D1');
  const alive = body.drv.find(d => d.id === 'D2');
  assert.ok(gone.fired);
  assert.equal(gone.ts, '');
  assert.equal(gone.plan[mk][day - 1], ''); // с сегодняшнего дня пусто
  if (day >= 2) assert.equal(gone.plan[mk][day - 2], 'р'); // вчера — история, цела
  assert.ok(!alive.fired);
  assert.equal(alive.plan[mk][day - 1], 'р');
  // повторный вызов ничего не меняет
  assert.equal(muteFiredInSchedule(db).muted, 0);
});

test('синк: гонка двух сотрудников не возвращает переведённого водителя (авторазвод)', t => {
  const db = freshDb(t);
  // Базовое состояние: Иванов в резерве E-RES, экипаж E069 пуст.
  applyScheduleSync(db, { since: 0, crews: {
    'E-RES': { id: 'E-RES', ts: [], drv: [{ id: 'D10', fio: 'Иванов Иван', crew: 'E-RES', ts: '' }] },
    E069: { id: 'E069', ts: [{ id: 'T69', tyagach: 'т869ат58', crew: 'E069' }], drv: [] }
  } });
  const base = Number(db.prepare(`SELECT value FROM app_meta WHERE key='schedule_rev'`).get().value);
  // Сотрудник А (видел base): переносит Иванова E-RES → E069, шлёт оба экипажа.
  applyScheduleSync(db, { since: base, crews: {
    'E-RES': { id: 'E-RES', ts: [], drv: [] },
    E069: { id: 'E069', ts: [{ id: 'T69', tyagach: 'т869ат58', crew: 'E069' }],
      drv: [{ id: 'D10', fio: 'Иванов Иван', crew: 'E069', ts: 'T69' }] }
  } });
  // Сотрудник Б (тоже видел только base, про перенос не знает): шлёт свою
  // устаревшую копию E-RES, где Иванов ещё в резерве.
  applyScheduleSync(db, { since: base, crews: {
    'E-RES': { id: 'E-RES', ts: [], drv: [{ id: 'D10', fio: 'Иванов Иван', crew: 'E-RES', ts: '' },
      { id: 'D11', fio: 'Петров Пётр', crew: 'E-RES', ts: '' }] }
  } });
  const res = JSON.parse(db.prepare(`SELECT body FROM schedule_crews WHERE id='E-RES'`).get().body);
  const e69 = JSON.parse(db.prepare(`SELECT body FROM schedule_crews WHERE id='E069'`).get().body);
  // Иванов остался только в E069; работа Б (Петров в резерв) не потеряна.
  assert.ok(!res.drv.some(d => d.id === 'D10'), 'устаревшая копия не вернула Иванова в резерв');
  assert.ok(e69.drv.some(d => d.id === 'D10'), 'перенос сотрудника А цел');
  assert.ok(res.drv.some(d => d.id === 'D11'), 'правка сотрудника Б не потеряна');
  // Журнал получил запись авторазвода.
  const note = db.prepare(`SELECT what FROM schedule_log WHERE author='планер' AND what LIKE 'авторазвод%'`).get();
  assert.ok(note, 'авторазвод записан в журнал');
  // Осознанный перенос: Б (с актуальным базисом) забирает Иванова к себе в E-RES.
  const rev2 = Number(db.prepare(`SELECT value FROM app_meta WHERE key='schedule_rev'`).get().value);
  applyScheduleSync(db, { since: rev2, crews: {
    'E-RES': { id: 'E-RES', ts: [], drv: [{ id: 'D10', fio: 'Иванов Иван', crew: 'E-RES', ts: '' },
      { id: 'D11', fio: 'Петров Пётр', crew: 'E-RES', ts: '' }] }
  } });
  const res2 = JSON.parse(db.prepare(`SELECT body FROM schedule_crews WHERE id='E-RES'`).get().body);
  const e692 = JSON.parse(db.prepare(`SELECT body FROM schedule_crews WHERE id='E069'`).get().body);
  assert.ok(res2.drv.some(d => d.id === 'D10'), 'свежий перенос применён');
  assert.ok(!e692.drv.some(d => d.id === 'D10'), 'из прежнего экипажа водитель удалён');
});

test('синк: повторно присланная запись журнала не дублируется', t => {
  const db = freshDb(t);
  const entry = { t: '2026-11-12 14:21', a: 'Никулина', what: 'закреплён за т869ат58', who: 'Храбров' };
  applyScheduleSync(db, { since: 0, crews: {}, remove: [], log: [entry] });
  applyScheduleSync(db, { since: 0, crews: {}, remove: [], log: [entry] });
  const n = db.prepare(`SELECT COUNT(*) c FROM schedule_log WHERE what='закреплён за т869ат58'`).get().c;
  assert.equal(n, 1);
});
