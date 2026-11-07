// «Выпуск» — единое место выпуска на линию (П2, 07.11.2026).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../src/db.mjs';
import { releaseBoard, techFail, techPass, prepNormHours } from '../src/release.mjs';
import { accessOf, assignRoleSets } from '../src/access.mjs';
import { createStaffUser } from '../src/staff.mjs';
import { hashPassword } from '../src/security.mjs';
import { effectivePermissions } from '../src/permissions.mjs';

function freshDb(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pegas-release-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = openDatabase(path.join(directory, 'planner.db'), {
    username: 'root-admin', password: 'Temporary-password-2026', fullName: 'Администратор'
  });
  t.after(() => db.close());
  return db;
}

function addTrip(db, vehicleId, startsAt) {
  const zones = db.prepare('SELECT id FROM zones LIMIT 2').all();
  const id = randomUUID();
  db.prepare(`INSERT INTO trips(id,vehicle_id,from_zone_id,to_zone_id,starts_at,ends_at,distance_km,revenue_vat,status)
    VALUES(?,?,?,?,?,?,500,100000,'plan')`).run(id, vehicleId, zones[0].id, zones[1].id, startsAt,
    new Date(Date.parse(startsAt) + 864e5).toISOString());
  return id;
}

test('чек-лист выпуска: из существующих отметок, норматив подготовки — регламент конвейера', t => {
  const db = freshDb(t);
  const vehicle = db.prepare(`SELECT id FROM vehicles WHERE status='work' LIMIT 1`).get();
  db.prepare(`UPDATE vehicles SET driver_name='Иванов И.' WHERE id=?`).run(vehicle.id);
  const now = Date.now();
  const tripId = addTrip(db, vehicle.id, new Date(now + 3.6e6).toISOString());
  let board = releaseBoard(db, now);
  let item = board.items.find(row => row.id === tripId);
  assert.equal(item.checks.driver, true);
  assert.equal(item.checks.waybill, false);
  assert.equal(item.checks.tech, false);
  assert.equal(prepNormHours(), 2);
  assert.equal(item.tone, 'risk'); // до выхода час, не готов
  // Путевой лист выдан, медосмотр, задание — остаётся техконтроль.
  const waybillId = randomUUID();
  db.prepare(`INSERT INTO waybills(id,year,number,vehicle_id,trip_id,starts_at,status,med_pre_at)
    VALUES(?,2026,1,?,?,?,'issued',?)`).run(waybillId, vehicle.id, tripId, new Date(now).toISOString(), new Date(now).toISOString());
  db.prepare(`UPDATE trips SET driver_notified_at=? WHERE id=?`).run(new Date(now).toISOString(), tripId);
  assert.ok(techPass(db, { vehicleId: vehicle.id, tripId, waybillId }, 'Контролёр').ok);
  assert.equal(db.prepare('SELECT tech_by FROM waybills WHERE id=?').get(waybillId).tech_by, 'Контролёр');
  board = releaseBoard(db, now);
  item = board.items.find(row => row.id === tripId);
  assert.deepEqual(item.missing, ['line']);
});

test('техконтроль не пройден — заезд в Ремзону с дефектом, без дубля заказ-наряда', t => {
  const db = freshDb(t);
  const vehicle = db.prepare(`SELECT id FROM vehicles WHERE status='work' LIMIT 1`).get();
  assert.equal(techFail(db, { vehicleId: vehicle.id, defect: '' }, 'К').ok, false);
  const first = techFail(db, { vehicleId: vehicle.id, defect: 'течь масла' }, 'Контролёр');
  assert.ok(first.ok);
  const order = db.prepare('SELECT * FROM repair_orders WHERE id=?').get(first.repairOrderId);
  assert.equal(order.status, 'queued');
  assert.match(order.complaint, /Техконтроль выпуска: течь масла/);
  const second = techFail(db, { vehicleId: vehicle.id, defect: 'фара' }, 'Контролёр');
  assert.equal(second.repairOrderId, first.repairOrderId);
  assert.equal(second.existed, true);
});

test('роль «Контролёр техсостояния»: только «Выпуск», право release:write, без денег', t => {
  const db = freshDb(t);
  const positionId = db.prepare('SELECT id FROM org_positions WHERE n=12').get().id;
  const r = createStaffUser(db, { fullName: 'Контролёр Тест', positionId, username: 'tech1', password: 'Very-strong-password-2026' }, { hashPassword });
  assert.ok(assignRoleSets(db, r.id, ['drv_tech']).ok);
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(r.id);
  assert.deepEqual(effectivePermissions(user), ['release:write']);
  assert.deepEqual(accessOf(db, user).views, ['release']);
  assert.equal(accessOf(db, user).money, 'none');
});
