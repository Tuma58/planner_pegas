// Платные парковки: разбор мест, слияние секций, пересборка, радиус.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../src/db.mjs';
import { upsertGibddFines } from '../src/gibdd.mjs';
import { distanceM, parkingKey, parkZoneNear, parseParkingLocation,
  rebuildParkingZones } from '../src/paidparking.mjs';

const freshDb = t => {
  const db = openDatabase(join(mkdtempSync(join(tmpdir(), 'pp-')), 'test.db'), {
    username: 'root-admin', password: 'Temporary-password-2026', fullName: 'Администратор'
  });
  t.after(() => db.close());
  return db;
};

test('разбор мест парковочных постановлений: живые форматы', () => {
  const a = parseParkingLocation('ПАРКОВКА №4092 (5) ГОРОД МОСКВА, ПЕРМСКАЯ УЛИЦА, ДОМ 3, СТРОЕНИЕ 26, МОСКВА Г.');
  assert.deepEqual(a, { parkingNo: '4092', street: 'ПЕРМСКАЯ УЛИЦА', house: '3', city: 'Москва' });
  const b = parseParkingLocation('ПАРКОВКА №4092 (2) МОСКВА, ПЕРМСКАЯ УЛИЦА, ДОМ 3, СТРОЕНИЕ 12, МОСКВА Г.');
  assert.equal(parkingKey(a), parkingKey(b)); // секции одной площадки сливаются
  const c = parseParkingLocation('ПЕРМСКАЯ УЛИЦА, ДОМ 1, СТРОЕНИЕ 5, МОСКВА Г.');
  assert.equal(c.parkingNo, '');
  assert.notEqual(parkingKey(a), parkingKey(c)); // дом 3 и дом 1 — разные точки
  const d = parseParkingLocation('УСАЧЕВА, д.29, к.1, ХАМОВНИКИ (ЦАО) Р-Н, МОСКВА Г.');
  assert.deepEqual([d.street, d.house], ['УСАЧЕВА', '29']);
  const e = parseParkingLocation('ЛЕНИНГРАДСКОЕ Ш., д.63, к.1, ЛЕВОБЕРЕЖНЫЙ (САО) Р-Н, МОСКВА Г.');
  assert.deepEqual([e.street, e.house], ['ЛЕНИНГРАДСКОЕ Ш.', '63']);
  // Тип улицы не мешает слиянию написаний.
  assert.equal(parkingKey({ street: 'УСАЧЕВА УЛИЦА', house: '29' }),
    parkingKey({ street: 'УСАЧЕВА', house: '29' }));
  const k2 = parseParkingLocation('ПАРКОВКА №4092 (11) ГОРОД МОСКВА, ЛОСИНООСТРОВСКАЯ УЛИЦА, ДОМ 40К2, МОСКВА Г.');
  assert.equal(k2.house, '40К2');
  assert.equal(parseParkingLocation('88 км 490 м а/д Лапотково - Ефремов'), null); // не парковка
});

test('справочник точек пересобирается из штрафов и копит счётчики', t => {
  const db = freshDb(t);
  const base = {
    gis_id: 1, auto_cdi: '58ХХ000222', in_processing: '0', bill_date: '2026-10-20',
    pay_due: '2026-12-29', amount: 25000, discount_pct: 0, discount_until: null,
    amount_discount: null, offense_time: '10:00', offense_at: '2026-10-10T07:00:00.000Z',
    article: '', status: 'nopayed',
    article_number: 'ЗГМ45-8.14 ч.2 - Неуплата за размещение транспортного средства на платной городской парковке г.Москвы'
  };
  upsertGibddFines(db, [
    { ...base, bill_id: 'УИН-П1', offense_on: '2026-10-10',
      location: 'ПАРКОВКА №4092 (3) ГОРОД МОСКВА, ПЕРМСКАЯ УЛИЦА, ДОМ 3, СТРОЕНИЕ 12, МОСКВА Г.' },
    { ...base, bill_id: 'УИН-П2', offense_on: '2026-10-12', amount: 5000,
      location: 'ПАРКОВКА №4092 (5) МОСКВА, ПЕРМСКАЯ УЛИЦА, ДОМ 3, СТРОЕНИЕ 26, МОСКВА Г.' },
    { ...base, bill_id: 'УИН-П3', offense_on: '2026-10-14',
      location: 'УСАЧЕВА, д.29, к.1, ХАМОВНИКИ (ЦАО) Р-Н, МОСКВА Г.' }
  ]);
  const first = rebuildParkingZones(db, randomUUID);
  assert.equal(first.zones, 2); // секции Пермской, 3 слились
  assert.equal(first.added, 2);
  const perm = db.prepare(`SELECT * FROM paid_park_zones WHERE street LIKE '%ПЕРМСКАЯ%'`).get();
  assert.equal(perm.fines_count, 2);
  assert.equal(perm.fines_amount, 30000);
  assert.equal(perm.parking_no, '4092');
  // Координаты пересборка не трогает; сид радиуса — вместо пустоты.
  db.prepare(`UPDATE paid_park_zones SET latitude=55.8213, longitude=37.7468, geo_status='ok'
    WHERE id=?`).run(perm.id);
  assert.equal(rebuildParkingZones(db, randomUUID).added, 0);
  assert.equal(db.prepare(`SELECT latitude FROM paid_park_zones WHERE id=?`).get(perm.id).latitude, 55.8213);
  const calc = JSON.parse(db.prepare(`SELECT value_json FROM settings WHERE key='calculation'`).get().value_json);
  assert.equal(calc.paidParkRadiusM, 400);

  // Радиус: борт в 200 м от точки ловится, в 2 км — нет, 0 — выключено.
  const near = parkZoneNear(db, { latitude: 55.8231, longitude: 37.7468 }, 400);
  assert.equal(near.street, 'ПЕРМСКАЯ УЛИЦА');
  assert.ok(near.awayM < 400 && near.awayM > 100);
  assert.equal(parkZoneNear(db, { latitude: 55.8413, longitude: 37.7468 }, 400), null);
  assert.equal(parkZoneNear(db, { latitude: 55.8213, longitude: 37.7468 }, 0), null);
  assert.ok(Math.abs(distanceM({ latitude: 55.8213, longitude: 37.7468 },
    { latitude: 55.8303, longitude: 37.7468 }) - 1000) < 20); // 0.009° широты ≈ 1 км
});
