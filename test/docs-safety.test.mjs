// Чек-лист продукта 07.11: «Документы» после выгрузки и журнал БДД.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../src/db.mjs';
import { docsBoard, docsNorm, markDocs } from '../src/trip-docs.mjs';
import { addSafetyEvent, closeSafetyEvent, importDtpRows, safetyBoard } from '../src/safety.mjs';
import { accessOf, assignRoleSets } from '../src/access.mjs';
import { createStaffUser } from '../src/staff.mjs';
import { hashPassword } from '../src/security.mjs';

function freshDb(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pegas-docs-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = openDatabase(path.join(directory, 'planner.db'), {
    username: 'root-admin', password: 'Temporary-password-2026', fullName: 'Администратор'
  });
  t.after(() => db.close());
  return db;
}
function trip(db, status, unloadedAt) {
  const vehicle = db.prepare(`SELECT id FROM vehicles LIMIT 1`).get();
  const zones = db.prepare('SELECT id FROM zones LIMIT 2').all();
  const id = randomUUID();
  db.prepare(`INSERT INTO trips(id,vehicle_id,from_zone_id,to_zone_id,starts_at,ends_at,distance_km,revenue_vat,status,unloaded_at)
    VALUES(?,?,?,?,?,?,500,100000,?,?)`).run(id, vehicle.id, zones[0].id, zones[1].id, unloadedAt, unloadedAt, status, unloadedAt);
  return id;
}

test('документы: учёт с момента включения, отметка после выгрузки, живой норматив', t => {
  const db = freshDb(t);
  const since = db.prepare(`SELECT value FROM app_meta WHERE key='docs_return_since'`).get().value;
  const before = trip(db, 'done', new Date(Date.parse(since) - 864e5).toISOString()); // старый — задачей не всплывает
  const now = Date.now();
  const waiting = trip(db, 'unloaded', new Date(Date.parse(since) + 1000).toISOString());
  const planned = trip(db, 'plan', new Date(now + 864e5).toISOString());
  let board = docsBoard(db, now + 60_000);
  assert.deepEqual(board.items.map(item => item.id), [waiting]);
  assert.equal(board.norm, null); // фактов мало — норматива нет
  assert.equal(markDocs(db, planned, 'originals', 'Учёт').ok, false); // до выгрузки нельзя
  assert.equal(markDocs(db, waiting, 'нет', 'Учёт').ok, false);
  assert.ok(markDocs(db, waiting, 'etrn', 'Учёт').ok);
  assert.equal(markDocs(db, waiting, 'etrn', 'Учёт').ok, false); // повторно — нет
  board = docsBoard(db, now + 60_000);
  assert.equal(board.items.length, 0);
  assert.equal(board.summary.returnedWeek, 1);
  assert.ok(before);
  assert.equal(docsNorm(db, now), null);
});

test('журнал БДД: ДТП требует описания, расследование закрывается мерами, сроки допусков', t => {
  const db = freshDb(t);
  const driver = db.prepare(`SELECT id FROM drivers LIMIT 1`).get();
  if (!driver) {
    db.prepare(`INSERT INTO drivers(id,full_name,status) VALUES('d1','Иванов Иван','active')`).run();
  }
  const driverId = driver?.id || 'd1';
  assert.equal(addSafetyEvent(db, { kind: 'dtp', driverId, happenedOn: '2026-11-05' }, 'БДД').ok, false);
  const dtp = addSafetyEvent(db, { kind: 'dtp', driverId, happenedOn: '2026-11-05', description: 'наезд на препятствие' }, 'БДД');
  assert.ok(dtp.ok);
  assert.equal(closeSafetyEvent(db, dtp.id, '', 'БДД').ok, false);
  assert.ok(closeSafetyEvent(db, dtp.id, 'внеплановый инструктаж', 'БДД').ok);
  assert.equal(addSafetyEvent(db, { kind: 'admission', driverId, happenedOn: '2026-11-01' }, 'БДД').ok, false); // срок обязателен
  assert.ok(addSafetyEvent(db, { kind: 'admission', driverId, happenedOn: '2026-11-01', validUntil: '2026-11-20' }, 'БДД').ok);
  const board = safetyBoard(db, { from: '2026-11-01', to: '2026-11-30', warnDays: 30, nowMs: Date.parse('2026-11-07T10:00:00Z') });
  assert.equal(board.summary.dtp, 1);
  assert.equal(board.terms[0].termStatus, 'soon');
  assert.ok(!board.withoutAdmission.some(row => row.id === driverId));
});

test('импорт ДТП из 1С: идемпотентный апсерт, виновность, воронка СК и динамика', t => {
  const db = freshDb(t);
  const vehicle = db.prepare(`SELECT id, plate FROM vehicles LIMIT 1`).get();
  db.prepare(`INSERT INTO drivers(id,full_name,status) VALUES('dtp-drv','Семёнов Пётр Петрович','active')`).run();
  const rows = [
    { externalNo: 'ПА000000125', happenedOn: '2026-08-01', plate: ` ${vehicle.plate.toUpperCase()} `,
      driverName: 'Семенов Петр Петрович', culpability: 'виновны', place: 'г. Москва',
      damage: 'правый угол', analysis: 'осмотр 04.08', comment: 'будет выплата',
      claimStatus: 'РемонтАТП', claimNo: '', paidRub: 0 },
    { externalNo: 'ПА000000126', happenedOn: '2026-09-10', plate: 'зз9999 99', pairedPlate: vehicle.plate,
      driverName: 'Семёнов Пётр Петрович', culpability: 'не виновны', place: 'Пенза',
      damage: 'бампер', analysis: '', comment: '', claimStatus: 'Выполнен', claimNo: '188349/26', paidRub: 8000 },
    { externalNo: '', happenedOn: '2026-09-11', plate: 'x', driverName: '', culpability: '', claimStatus: '' }
  ];
  const first = importDtpRows(db, rows, 'БДД', '2026-11-14T08:00:00.000Z');
  assert.deepEqual([first.added, first.updated, first.skipped.length], [2, 0, 1]);
  const saved = db.prepare(`SELECT * FROM safety_events WHERE external_no='ПА000000125'`).get();
  assert.equal(saved.vehicle_id, vehicle.id); // госномер сматчился с пробелами и регистром
  assert.equal(saved.driver_id, 'dtp-drv'); // ФИО сматчилось без «ё»
  assert.equal(saved.culpability, 'guilty');
  assert.equal(saved.status, 'open');
  const done = db.prepare(`SELECT * FROM safety_events WHERE external_no='ПА000000126'`).get();
  assert.equal(done.status, 'closed'); // «Выполнен» в 1С = закрыто
  assert.equal(done.culpability, 'notguilty');
  assert.equal(done.paid_rub, 8000);
  assert.equal(done.vehicle_id, vehicle.id); // прицеп не найден → привязка к тягачу сцепки
  assert.equal(done.plate, 'зз9999 99'); // но номер прицепа в тексте сохранён
  // Повторный импорт: обновление, не дубль; продвижение этапа видно.
  rows[0].claimStatus = 'НаправлениеСТОА';
  const second = importDtpRows(db, rows, 'БДД', '2026-11-15T08:00:00.000Z');
  assert.deepEqual([second.added, second.updated], [0, 2]);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM safety_events WHERE kind='dtp'`).get().n, 2);
  assert.equal(db.prepare(`SELECT claim_status FROM safety_events WHERE external_no='ПА000000125'`).get().claim_status, 'НаправлениеСТОА');
  // Отчётность: воронка открытых дел, динамика 6 месяцев, виновность в сводке.
  const board = safetyBoard(db, { from: '2026-08-01', to: '2026-11-14', warnDays: 30, nowMs: Date.parse('2026-11-14T10:00:00Z') });
  assert.equal(board.summary.dtpGuilty, 1);
  assert.equal(board.summary.dtpNotGuilty, 1);
  assert.equal(board.summary.paidRub, 8000);
  assert.equal(board.months.length, 6);
  assert.equal(board.months.at(-1).month, '2026-11');
  assert.equal(board.months.find(row => row.month === '2026-08').dtp, 1);
  assert.deepEqual(board.claimFunnel, [{ stage: 'НаправлениеСТОА', label: 'направление СТОА', count: 1 }]);
  assert.ok(board.claims[0].ageDays > 100); // дело с августа — возраст виден
});

test('роли: БДД — журнал без денег; руководитель логистики — «Отчёты отдела»', t => {
  const db = freshDb(t);
  const make = (n, set) => {
    const positionId = db.prepare('SELECT id FROM org_positions WHERE n=?').get(n).id;
    const r = createStaffUser(db, { fullName: `Т ${n}`, positionId, username: `t${n}`, password: 'Very-strong-password-2026' }, { hashPassword });
    assert.ok(assignRoleSets(db, r.id, [set]).ok);
    return accessOf(db, db.prepare('SELECT * FROM users WHERE id=?').get(r.id));
  };
  const bdd = make(2, 'staff_bdd');
  assert.ok(bdd.views.includes('safety'));
  assert.equal(bdd.money, 'none');
  assert.ok(make(5, 'log_head').views.includes('logreports'));
  assert.ok(make(11, 'drv_acc').views.includes('docs'));
});
