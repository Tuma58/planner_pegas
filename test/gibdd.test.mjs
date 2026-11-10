// Коннектор OnlineГИБДД — штрафы по парку (09.11.2026, проект «Слияние»).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../src/db.mjs';
import { fineCategory, gibddBoard, importSts, mapApiFines, normCdi, offenseIso, plateParts, upsertGibddFines } from '../src/gibdd.mjs';

function freshDb(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pegas-gibdd-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = openDatabase(path.join(directory, 'planner.db'), {
    username: 'root-admin', password: 'Temporary-password-2026', fullName: 'Администратор'
  });
  t.after(() => db.close());
  return db;
}

test('госномер планера раскладывается на номер и регион для API', () => {
  assert.deepEqual(plateParts('р901ар58'), { number: 'Р901АР', region: '58' });
  assert.deepEqual(plateParts('о080тк797'), { number: 'О080ТК', region: '797' });
  assert.deepEqual(plateParts('a123bc58'), { number: 'А123ВС', region: '58' }); // латиница
  assert.deepEqual(plateParts('ам0427 58'), { number: 'АМ0427', region: '58' }); // прицеп
  assert.equal(plateParts('трактор'), null);
  assert.equal(normCdi('99 ав 123456'), '99АВ123456');
});

test('момент нарушения: местные часы постановления трактуются как МСК', () => {
  assert.equal(offenseIso('2026-11-01', '20:24'), '2026-11-01T17:24:00.000Z');
  assert.equal(offenseIso('2026-11-01', ''), '2026-10-31T21:00:00.000Z'); // без времени — полночь МСК
  assert.equal(offenseIso('', '12:00'), null);
});

test('ответ API разбирается в плоские строки', () => {
  const rows = mapApiFines({
    today_date: '2026-11-09',
    auto_list: { 0: { auto_id: 1, auto_cdi: '9913901743', offense_list: {
      0: { gis_id: 8646671, gis_status: 'nopayed', bill_id: '18810177200618782654',
        pay_bill_date: '2026-11-01', last_bill_date: '2026-12-10', pay_bill_amount: 500,
        gis_discount: 50, gis_discount_uptodate: '2026-11-20', pay_bill_amount_with_discount: 250,
        offense_date: '2026-10-30', offense_time: '20:24', offense_location: 'МОСКВА Г. ТТК',
        offense_article_number: '12.16.1', offense_article: '12.16.1 - Несоблюдение требований знаков' },
      1: { gis_id: 8646672, gis_status: 'payed', bill_id: '18810177200618716049',
        pay_bill_date: '2026-10-05', pay_bill_amount: 800, offense_date: '2026-10-01', offense_time: '08:11' }
    } } }
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].bill_id, '18810177200618782654');
  assert.equal(rows[0].status, 'nopayed');
  assert.equal(rows[0].amount_discount, 250);
  assert.equal(rows[0].offense_at, '2026-10-30T17:24:00.000Z');
  assert.equal(rows[1].status, 'payed');
});

test('штраф ложится в журнал с машиной по СТС и виновником по закреплению; повтор — не дубль', t => {
  const db = freshDb(t);
  const vehicle = db.prepare(`SELECT id, plate FROM vehicles WHERE status='work' LIMIT 1`).get();
  db.prepare(`INSERT INTO vehicle_cards(vehicle_id, sts_number) VALUES(?, '99 АВ 123456')`).run(vehicle.id);
  const driverThen = randomUUID();
  const driverNow = randomUUID();
  db.prepare(`INSERT INTO drivers(id, full_name) VALUES(?, 'Тогдашний Водитель')`).run(driverThen);
  db.prepare(`INSERT INTO drivers(id, full_name) VALUES(?, 'Нынешний Водитель')`).run(driverNow);
  db.prepare(`INSERT INTO driver_assignments(id, driver_id, vehicle_id, starts_at, ends_at)
    VALUES(?, ?, ?, '2026-10-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')`).run(randomUUID(), driverThen, vehicle.id);
  db.prepare(`INSERT INTO driver_assignments(id, driver_id, vehicle_id, starts_at, ends_at)
    VALUES(?, ?, ?, '2026-11-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z')`).run(randomUUID(), driverNow, vehicle.id);
  const row = {
    bill_id: '18810158260001234567', gis_id: 1, auto_cdi: normCdi('99АВ123456'),
    status: 'nopayed', in_processing: '0', bill_date: '2026-10-20', pay_due: '2026-12-29',
    amount: 500, discount_pct: 50, discount_until: '2026-11-09', amount_discount: 250,
    offense_on: '2026-10-15', offense_time: '14:00', offense_at: '2026-10-15T11:00:00.000Z',
    location: 'ПЕНЗА', article_number: '12.09.2', article: 'Превышение скорости'
  };
  const first = upsertGibddFines(db, [row]);
  assert.deepEqual([first.added, first.updated], [1, 0]);
  const saved = db.prepare('SELECT * FROM gibdd_fines WHERE bill_id=?').get(row.bill_id);
  assert.equal(saved.vehicle_id, vehicle.id);
  assert.equal(saved.driver_name, 'Тогдашний Водитель'); // кто был за рулём 15.10, а не сейчас
  // Повторная синхронизация без изменений — тишина.
  const repeat = upsertGibddFines(db, [row]);
  assert.deepEqual([repeat.added, repeat.updated], [0, 0]);
  // Штраф оплатили — статус обновился, дубля нет, момент оплаты отмечен.
  const paid = upsertGibddFines(db, [{ ...row, status: 'payed' }]);
  assert.deepEqual([paid.added, paid.updated, paid.paidNew], [0, 1, 1]);
  const after = db.prepare('SELECT * FROM gibdd_fines WHERE bill_id=?').get(row.bill_id);
  assert.equal(after.status, 'payed');
  assert.ok(after.paid_seen_at);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM gibdd_fines').get().n, 1);
  // Неизвестный СТС честно виден в сводке синхронизации.
  const alien = upsertGibddFines(db, [{ ...row, bill_id: '18810158260007654321', auto_cdi: '77ХХ000001' }]);
  assert.deepEqual(alien.unknownCdi, ['77ХХ000001']);
});

test('штраф, пришедший раньше СТС, дозаполняется машиной и виновником при повторе', t => {
  const db = freshDb(t);
  const vehicle = db.prepare(`SELECT id, plate FROM vehicles WHERE status='work' LIMIT 1`).get();
  db.prepare(`UPDATE vehicles SET driver_name='Текущий Водитель' WHERE id=?`).run(vehicle.id);
  const row = {
    bill_id: '18810158260009990001', gis_id: 2, auto_cdi: '58КК777888', status: 'nopayed',
    in_processing: '0', bill_date: '2026-11-01', pay_due: '2026-12-29', amount: 500,
    discount_pct: 50, discount_until: '2026-11-15', amount_discount: 250,
    offense_on: '2026-10-25', offense_time: '09:00', offense_at: '2026-10-25T06:00:00.000Z',
    location: 'ПЕНЗА', article_number: '12.09.2', article: ''
  };
  upsertGibddFines(db, [row]); // СТС ещё нигде нет — штраф без машины
  assert.equal(db.prepare('SELECT vehicle_id FROM gibdd_fines WHERE bill_id=?').get(row.bill_id).vehicle_id, null);
  // СТС появился в паспорте (импорт из ЛК) — повторная синхронизация дозаполняет.
  db.prepare(`INSERT INTO vehicle_cards(vehicle_id, sts_number) VALUES(?, '58КК777888')`).run(vehicle.id);
  const second = upsertGibddFines(db, [row]);
  assert.equal(second.updated, 1);
  const saved = db.prepare('SELECT * FROM gibdd_fines WHERE bill_id=?').get(row.bill_id);
  assert.equal(saved.vehicle_id, vehicle.id);
  assert.equal(saved.plate, vehicle.plate);
  assert.equal(saved.driver_name, 'Текущий Водитель'); // фолбэк без закреплений
  // Третий прогон без изменений — тишина.
  assert.equal(upsertGibddFines(db, [row]).updated, 0);
});

test('обжалованный штраф не считается неоплаченным', t => {
  const db = freshDb(t);
  const rows = mapApiFines({ auto_list: { 0: { auto_cdi: '5800111222', offense_list: {
    0: { gis_id: 3, gis_status: 'revoked', bill_id: 'УИН-ОБЖ', pay_bill_amount: 250000,
      offense_date: '2026-11-02', offense_time: '10:00' }
  } } } });
  assert.equal(rows[0].status, 'revoked');
  upsertGibddFines(db, rows);
  const board = gibddBoard(db, { from: '2026-11-01', to: '2026-11-09', warnDays: 7,
    nowMs: Date.parse('2026-11-09T09:00:00.000Z') });
  assert.equal(board.unpaidCount, 0);
  assert.equal(board.fines.length, 1); // в журнале периода виден
});

test('СТС подтягиваются из личного кабинета по госномеру; заполненные не перетираются', t => {
  const db = freshDb(t);
  const [first, second] = db.prepare(`SELECT id, plate FROM vehicles WHERE status='work' ORDER BY plate LIMIT 2`).all();
  db.prepare(`INSERT INTO vehicle_cards(vehicle_id, sts_number) VALUES(?, '58АА000001')`).run(second.id);
  const parts = p => {
    const m = p.toUpperCase().match(/^(.{6})(\d{2,3})$/);
    return { auto_number: m[1], auto_region: m[2] };
  };
  const imported = importSts(db, [
    { auto_cdi: '9911000001', ...parts(first.plate) },   // пустой паспорт — заполнится
    { auto_cdi: '9911000002', ...parts(second.plate) },  // СТС уже есть — не перетирается
    { auto_cdi: '9911000003', auto_number: 'Х999ХХ', auto_region: '99' } // чужой номер — мимо
  ]);
  assert.equal(imported, 1);
  assert.equal(db.prepare('SELECT sts_number FROM vehicle_cards WHERE vehicle_id=?').get(first.id).sts_number, '9911000001');
  assert.equal(db.prepare('SELECT sts_number FROM vehicle_cards WHERE vehicle_id=?').get(second.id).sts_number, '58АА000001');
  // Повтор — тишина: СТС уже у нас.
  assert.equal(importSts(db, [{ auto_cdi: '9911000001', ...parts(first.plate) }]), 0);
});

test('свод для экрана БДД: неоплаченные, горящая скидка, машины без СТС', t => {
  const db = freshDb(t);
  const vehicle = db.prepare(`SELECT id, plate FROM vehicles WHERE status='work' LIMIT 1`).get();
  db.prepare(`INSERT INTO vehicle_cards(vehicle_id, sts_number) VALUES(?, '9911222333')`).run(vehicle.id);
  const nowMs = Date.parse('2026-11-09T09:00:00.000Z');
  const base = {
    gis_id: 1, auto_cdi: '9911222333', in_processing: '0', bill_date: '2026-11-01',
    pay_due: '2026-12-29', amount: 500, discount_pct: 50, amount_discount: 250,
    offense_time: '10:00', offense_at: '2026-11-01T07:00:00.000Z',
    location: '', article_number: '12.9.2', article: ''
  };
  upsertGibddFines(db, [
    { ...base, bill_id: 'УИН-1', status: 'nopayed', offense_on: '2026-11-01', discount_until: '2026-11-12' },
    { ...base, bill_id: 'УИН-2', status: 'nopayed', offense_on: '2026-11-03', discount_until: '2026-12-05' },
    { ...base, bill_id: 'УИН-3', status: 'payed', offense_on: '2026-10-20', discount_until: null }
  ]);
  const board = gibddBoard(db, { from: '2026-11-01', to: '2026-11-09', warnDays: 7, nowMs });
  assert.equal(board.fines.length, 2); // оплаченный — вне периода нарушения
  assert.equal(board.unpaidCount, 2);
  assert.equal(board.unpaidAmount, 500); // обе со скидкой: 250 + 250
  assert.deepEqual(board.burning.map(fine => fine.bill_id), ['УИН-1']); // скидка до 12.11, порог 7 дн
  assert.ok(board.withoutSts.length > 0); // остальной демо-парк без СТС
});

test('категории штрафов: Платон и Автодор отделяются от ПДД по статье', t => {
  assert.equal(fineCategory('ст.12.21.3 ч.1'), 'platon');
  assert.equal(fineCategory('12.21.4.2 - Неуплата за проезд грузового ТС или автобуса по платным автодорогам'), 'avtodor');
  assert.equal(fineCategory('ЗГМ45-10.13 ч.2 - Неуплата за проезд грузового ТС или автобуса по платным автодорогам'), 'avtodor');
  assert.equal(fineCategory('ЗГМ45-8.14 п.2 Неуплата или нарушение порядка оплаты за платную парковку г.Москвы'), 'pdd'); // парковка — не дорога
  assert.equal(fineCategory('12.09.2 - Превышение скорости движения ТС от 20 до 40 км/ч'), 'pdd');
  assert.equal(fineCategory(''), 'pdd');

  const db = freshDb(t);
  const vehicle = db.prepare(`SELECT id FROM vehicles WHERE status='work' LIMIT 1`).get();
  db.prepare(`INSERT INTO vehicle_cards(vehicle_id, sts_number) VALUES(?, '9911222333')`).run(vehicle.id);
  const nowMs = Date.parse('2026-11-09T09:00:00.000Z');
  const base = {
    gis_id: 1, auto_cdi: '9911222333', in_processing: '0', bill_date: '2026-11-01',
    pay_due: '2026-12-29', amount: 500, discount_pct: 50, amount_discount: 250,
    offense_time: '10:00', offense_at: '2026-11-01T07:00:00.000Z',
    location: '', article: '', status: 'nopayed', offense_on: '2026-11-01', discount_until: '2026-12-05'
  };
  upsertGibddFines(db, [
    { ...base, bill_id: 'УИН-ПДД', article_number: '12.09.2 - Превышение скорости' },
    { ...base, bill_id: 'УИН-Платон', article_number: 'ст.12.21.3 ч.1', amount: 10000, amount_discount: 5000 },
    { ...base, bill_id: 'УИН-Автодор', article_number: '12.21.4.2 - Неуплата за проезд по платным автодорогам' }
  ]);
  const board = gibddBoard(db, { from: '2026-11-01', to: '2026-11-09', warnDays: 7, nowMs });
  assert.equal(board.fines.find(fine => fine.bill_id === 'УИН-Платон').category, 'platon');
  assert.equal(board.byCategory.platon.unpaidCount, 1);
  assert.equal(board.byCategory.platon.unpaidAmount, 5000); // со скидкой, пока действует
  assert.equal(board.byCategory.avtodor.unpaidCount, 1);
  assert.equal(board.byCategory.pdd.unpaidCount, 1);
  // Сумма разбивки сходится с общим итогом.
  assert.equal(board.byCategory.pdd.unpaidAmount + board.byCategory.platon.unpaidAmount
    + board.byCategory.avtodor.unpaidAmount, board.unpaidAmount);
});
