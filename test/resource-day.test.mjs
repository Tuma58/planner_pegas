// «Ресурс за день» (ТЗ Базуева 16.11): срез парка по состояниям за
// МСК-день — приоритет категорий и фолбэк «ремонт из заказ-наряда».
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../src/db.mjs';
import { resourceDayData } from '../src/resource-day.mjs';

function freshDb(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pegas-resday-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = openDatabase(path.join(directory, 'planner.db'), {
    username: 'root-admin', password: 'Temporary-password-2026', fullName: 'Администратор'
  });
  t.after(() => db.close());
  return db;
}

test('ресурс за день: категории по приоритету, итог сходится с парком', t => {
  const db = freshDb(t);
  const vehicles = db.prepare(`SELECT id, plate FROM vehicles WHERE status='work' ORDER BY plate LIMIT 4`).all();
  assert.ok(vehicles.length >= 4, 'в стартовой базе есть машины');
  const [onLine, inRepair, onShift, fallbackRepair] = vehicles;
  const zone = db.prepare(`SELECT id FROM zones LIMIT 1`).get().id;
  const day = '2026-11-15'; // МСК-день отчёта
  // Рейс, перекрывающий день (и одновременно пересменка — рейс главнее).
  db.prepare(`INSERT INTO trips(id, vehicle_id, from_zone_id, to_zone_id, starts_at, ends_at,
      status, customer_name, distance_km, revenue_vat) VALUES(?,?,?,?,?,?,?,?,0,0)`)
    .run(randomUUID(), onLine.id, zone, zone, '2026-11-14T20:00:00.000Z', '2026-11-15T10:00:00.000Z',
      'run', 'Тест-клиент');
  db.prepare(`INSERT INTO vehicle_dispositions(id, vehicle_id, kind, starts_at, ends_at, note)
      VALUES(?,?,?,?,?,?)`)
    .run(randomUUID(), onLine.id, 'shift', '2026-11-15T12:00:00.000Z', '2026-11-15T18:00:00.000Z', '');
  // Чистый ремонт диспозицией и чистая пересменка.
  db.prepare(`INSERT INTO vehicle_dispositions(id, vehicle_id, kind, starts_at, ends_at, note)
      VALUES(?,?,?,?,?,?)`)
    .run(randomUUID(), inRepair.id, 'repair', '2026-11-14T00:00:00.000Z', '2026-11-16T00:00:00.000Z', 'КПП');
  db.prepare(`INSERT INTO vehicle_dispositions(id, vehicle_id, kind, starts_at, ends_at, note)
      VALUES(?,?,?,?,?,?)`)
    .run(randomUUID(), onShift.id, 'shift', '2026-11-15T06:00:00.000Z', '2026-11-15T20:00:00.000Z', '');
  // Ремонт без диспозиции — фолбэк из заказ-наряда Ремзоны (в работе).
  db.prepare(`INSERT INTO repair_orders(id, vehicle_id, status, purpose)
      VALUES(?,?,?,?)`).run(randomUUID(), fallbackRepair.id, 'in_progress', 'ходовая');

  const report = resourceDayData(db, day);
  const byPlate = Object.fromEntries(report.rows.map(row => [row.plate, row]));
  assert.equal(byPlate[onLine.plate].category, 'line', 'рейс главнее пересменки');
  assert.equal(byPlate[inRepair.plate].category, 'repair');
  assert.equal(byPlate[onShift.plate].category, 'shift');
  assert.equal(byPlate[fallbackRepair.plate].category, 'repair', 'заказ-наряд без диспозиции');
  assert.match(byPlate[fallbackRepair.plate].detail, /заказ-наряд/);
  // Сумма категорий равна парку; вне диспозиций и рейсов — простой.
  const total = report.order.reduce((sum, key) => sum + report.counters[key], 0);
  assert.equal(total, report.fleet);
  assert.ok(report.counters.idle >= 0);
  // Соседний день пересменку onLine не видит, а раннюю пересменку — да.
  const nextDay = resourceDayData(db, '2026-11-16');
  assert.notEqual(nextDay.rows.find(row => row.plate === onShift.plate)?.category, 'shift');
});
