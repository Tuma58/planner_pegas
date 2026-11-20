// Пульс табло: сборка плашек «против своей нормы» (живой норматив —
// медиана собственного ряда без сегодняшнего дня).
import test from 'node:test';
import assert from 'node:assert/strict';
import { pulseQuotes } from '../src/tablo.mjs';

const series = values => values.map((value, idx) => ({ day: `2026-11-${String(idx + 1).padStart(2, '0')}`, value }));

test('норма — медиана прошлых дней, сегодня в неё не входит', () => {
  const [quote] = pulseQuotes([{ key: 'online', label: 'На линии', better: 'up',
    series: series([100, 102, 104, 106, 120]) }]);
  assert.equal(quote.norm, 104); // медиана 100,102,104,106 → нижняя средняя
  assert.equal(quote.value, 120);
  assert.equal(quote.delta, 16);
  assert.equal(quote.tone, 'good');
});

test('у счётчиков «меньше — лучше» рост красит плашку в плохое', () => {
  const [quote] = pulseQuotes([{ key: 'nocrew', label: 'Без экипажа', better: 'down',
    series: series([2, 2, 3, 2, 7]) }]);
  assert.equal(quote.tone, 'bad');
  const [drop] = pulseQuotes([{ key: 'nocrew', label: 'Без экипажа', better: 'down',
    series: series([5, 4, 5, 4, 1]) }]);
  assert.equal(drop.tone, 'good');
});

test('пустые дни не ломают медиану, без истории — нейтральный тон', () => {
  const [quote] = pulseQuotes([{ key: 'rate', label: 'Ставка', better: 'up',
    series: series([null, null, null, 97]) }]);
  assert.equal(quote.norm, null);
  assert.equal(quote.delta, null);
  assert.equal(quote.tone, 'flat');
});

test('совпадение с нормой — ровный тон, спарклайн отдаёт весь ряд', () => {
  const [quote] = pulseQuotes([{ key: 'keip', label: 'КЭИП', better: 'up',
    series: series([80, 80, 80]) }]);
  assert.equal(quote.tone, 'flat');
  assert.deepEqual(quote.spark, [80, 80, 80]);
});

// Лента событий: подпись рейса городами из точек либо клиентом.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../src/db.mjs';
import { tabloTape } from '../src/tablo.mjs';

function freshDb(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pegas-tablo-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = openDatabase(path.join(directory, 'planner.db'), {
    username: 'root-admin', password: 'Temporary-password-2026', fullName: 'Администратор'
  });
  t.after(() => db.close());
  return db;
}

function seedTrip(db, { customer = 'ЧМПЗ АО Пенза' } = {}) {
  const vehicle = db.prepare(`SELECT id FROM vehicles WHERE status='work' LIMIT 1`).get();
  const zones = db.prepare('SELECT id FROM zones LIMIT 2').all();
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO trips(id, vehicle_id, customer_name, from_zone_id, to_zone_id,
      starts_at, ends_at, distance_km, revenue_vat, status, created_at, unloaded_at)
    VALUES(?,?,?,?,?,?,?,650,120000,'unloaded',?,?)`)
    .run(id, vehicle.id, customer, zones[0].id, zones[1]?.id || zones[0].id, now, now, now, now);
  db.prepare(`INSERT INTO trip_stops(id, trip_id, seq, kind, point) VALUES(?,?,1,'P','г. Пенза, Рябова 2')`)
    .run(randomUUID(), id);
  db.prepare(`INSERT INTO trip_stops(id, trip_id, seq, kind, point) VALUES(?,?,2,'D','Москва г, Бирюлёво')`)
    .run(randomUUID(), id);
  return id;
}

test('лента: рейс подписывается городами точек, не зонами', t => {
  const db = freshDb(t);
  seedTrip(db);
  const tape = tabloTape(db);
  const unloaded = tape.events.find(event => event.kind === 'unloaded');
  assert.ok(unloaded, 'выгрузка попала в ленту');
  assert.match(unloaded.text, /Пенза → Москва/);
  assert.ok(unloaded.amount > 0, 'сумма нетто при выгрузке');
});

test('лента: настройка tapeTripLabel=customer переключает подпись на клиента', t => {
  const db = freshDb(t);
  const calcRow = db.prepare(`SELECT value_json FROM settings WHERE key='calculation'`).get();
  const calc = calcRow ? JSON.parse(calcRow.value_json) : {};
  calc.tapeTripLabel = 'customer';
  db.prepare(`INSERT INTO settings(key, value_json) VALUES('calculation', ?)
    ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json`).run(JSON.stringify(calc));
  seedTrip(db, { customer: 'Коралл ООО' });
  const tape = tabloTape(db);
  const event = tape.events.find(item => item.kind === 'new_trip');
  assert.ok(event, 'новый рейс попал в ленту');
  assert.match(event.text, /Коралл ООО/);
  assert.equal(tape.labelMode, 'customer');
});

// Контрольные точки + лучшие экипажи (Э3).
import { tabloControl } from '../src/tablo.mjs';

test('контрольные точки: заявка завтра без ТС попадает в сторож 18:00', t => {
  const db = freshDb(t);
  const zone = db.prepare('SELECT id FROM zones LIMIT 1').get();
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  db.prepare(`INSERT INTO orders(id, customer_name, from_zone_id, to_zone_id, rate_vat, window_from, window_to, status)
    VALUES(?, 'Коралл ООО', ?, ?, 120000, ?, ?, 'new')`)
    .run(randomUUID(), zone.id, zone.id, `${tomorrow}T05:00:00.000Z`, `${tomorrow}T10:00:00.000Z`);
  const control = tabloControl(db);
  const point = control.checkpoints.find(item => item.key === 'handoff_trip_plan');
  assert.ok(point, 'сторож плана рейсов на месте');
  assert.equal(point.deadline, '18:00');
  assert.ok(point.count >= 1);
  assert.equal(point.tone, 'bad');
});

test('лучшие экипажи: вчерашняя выгрузка выводит борт в топ', t => {
  const db = freshDb(t);
  const vehicle = db.prepare(`SELECT id, plate FROM vehicles WHERE status='work' LIMIT 1`).get();
  const zones = db.prepare('SELECT id FROM zones LIMIT 2').all();
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  db.prepare(`INSERT INTO trips(id, vehicle_id, customer_name, from_zone_id, to_zone_id,
      starts_at, ends_at, distance_km, revenue_vat, status, unloaded_at)
    VALUES(?, ?, 'Коралл ООО', ?, ?, ?, ?, 650, 220000, 'unloaded', ?)`)
    .run(randomUUID(), vehicle.id, zones[0].id, zones[1]?.id || zones[0].id,
      `${yesterday}T01:00:00.000Z`, `${yesterday}T09:00:00.000Z`, `${yesterday}T09:30:00.000Z`);
  const control = tabloControl(db);
  assert.equal(control.day, yesterday);
  assert.ok(control.crews.length >= 1, 'топ экипажей не пуст');
  assert.equal(control.crews[0].plate, vehicle.plate);
  assert.ok(control.crews[0].net > 0);
});
