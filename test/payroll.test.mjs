// ∑ ФОТ водителей — сдельная зарплата по Положению среды СТ (П5, 07.11.2026).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../src/db.mjs';
import { markAttendance } from '../src/planner-service.mjs';
import { migratePayroll, payrollReport, payrollApi, payrollRates } from '../src/payroll.mjs';

function freshDb(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pegas-payroll-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = openDatabase(path.join(directory, 'planner.db'), {
    username: 'root-admin', password: 'Temporary-password-2026', fullName: 'Администратор'
  });
  t.after(() => db.close());
  migratePayroll(db);
  return db;
}

// Водитель на свободной машине и три отмеченных дня работы 02–04.10.
function setup(db) {
  const vehicle = db.prepare(`SELECT id FROM vehicles WHERE status='work'
    AND id NOT IN (SELECT vehicle_id FROM drivers WHERE vehicle_id IS NOT NULL) LIMIT 1`).get()
    || db.prepare(`SELECT id FROM vehicles WHERE status='work' LIMIT 1`).get();
  db.prepare(`UPDATE drivers SET vehicle_id=NULL WHERE vehicle_id=?`).run(vehicle.id);
  const driverId = randomUUID();
  db.prepare(`INSERT INTO drivers(id, full_name, vehicle_id) VALUES(?,?,?)`).run(driverId, 'Тестов Тест Тестович', vehicle.id);
  for (const day of ['2026-10-02', '2026-10-03', '2026-10-04']) {
    markAttendance(db, { driverId, day, status: 'present' });
  }
  return { driverId, vehicleId: vehicle.id };
}

const odo = (db, vehicleId, day, km) => db.prepare(`INSERT INTO vehicle_odometers(vehicle_id, day, odo_km)
  VALUES(?,?,?)`).run(vehicleId, day, km);
const report = (db, extra = {}) => payrollReport(db, { from: '2026-10-01', to: '2026-10-10', ratePerKm: 12, guaranteePerDay: 4000, ...extra });
const rowOf = (data, driverId) => data.rows.find(row => row.driverId === driverId);

test('сдельно: км по одометру × ставка больше гарантии — к выплате сдельно', t => {
  const db = freshDb(t);
  const { driverId, vehicleId } = setup(db);
  odo(db, vehicleId, '2026-10-02', 100000);
  odo(db, vehicleId, '2026-10-05', 101500);
  const row = rowOf(report(db), driverId);
  assert.equal(row.days, 3);
  assert.equal(row.km, 1500);
  assert.equal(row.kmSource, 'одометр');
  assert.equal(row.piece, 18000);
  assert.equal(row.guarantee, 12000);
  assert.equal(row.payable, 18000);
  assert.equal(row.basis, 'сдельно');
  assert.equal(row.topUp, 0);
});

test('гарантия: мало км — к выплате гарантия за дни работы (больший из двух)', t => {
  const db = freshDb(t);
  const { driverId, vehicleId } = setup(db);
  odo(db, vehicleId, '2026-10-02', 100000);
  odo(db, vehicleId, '2026-10-05', 100500);
  const data = report(db);
  const row = rowOf(data, driverId);
  assert.equal(row.piece, 6000);
  assert.equal(row.guarantee, 12000);
  assert.equal(row.payable, 12000);
  assert.equal(row.basis, 'гарантия');
  assert.equal(row.topUp, 6000);
  assert.equal(data.method, 'period');
  assert.ok(data.totals.payable >= 12000);
});

test('нет одометров — км рейсов машины в дни работы, источник помечен', t => {
  const db = freshDb(t);
  const { driverId, vehicleId } = setup(db);
  const zones = db.prepare('SELECT id FROM zones LIMIT 2').all();
  db.prepare(`INSERT INTO trips(id,vehicle_id,from_zone_id,to_zone_id,starts_at,ends_at,unloaded_at,distance_km,revenue_vat,status)
    VALUES(?,?,?,?,?,?,?,800,100000,'done')`).run(randomUUID(), vehicleId, zones[0].id, zones[1].id,
    '2026-10-02T06:00:00.000Z', '2026-10-03T06:00:00.000Z', '2026-10-03T06:00:00.000Z');
  const row = rowOf(report(db), driverId);
  assert.equal(row.km, 800);
  assert.equal(row.kmSource, 'рейсы');
  assert.equal(row.piece, 9600);
  assert.equal(row.payable, 12000);
  assert.ok(row.notes.some(note => note.includes('нет снимков одометра')));
});

test('ставки — из настроек; ноль — осознанное значение, пустота — положение СТ', () => {
  assert.deepEqual([payrollRates({}).ratePerKm, payrollRates({}).guaranteePerDay], [12, 4000]);
  const zero = payrollRates({ calculation: { driverRatePerKm: 0, driverGuaranteePerDay: '' } });
  assert.equal(zero.ratePerKm, 0);
  assert.equal(zero.guaranteePerDay, 4000);
  assert.equal(zero.overtimePerDay, null);
});

function stubCtx(db, { access, user = { id: 'u1' }, perms = [], query = '' }) {
  const out = {};
  return {
    out,
    ctx: {
      db, user, access,
      request: { method: 'GET' }, response: {},
      url: new URL(`http://x/api/payroll${query}`), pathname: '/api/payroll',
      json: (response, status, obj) => { out.status = status; out.body = obj; },
      errorJson: (response, status, msg) => { out.status = status; out.error = msg; },
      hasPermission: (u, perm) => perms.includes(perm),
      settingsObject: () => ({ calculation: {} })
    }
  };
}

test('права: ведомость только уровню денег «все» — иначе 403', t => {
  const db = freshDb(t);
  const { driverId } = setup(db);
  const query = '?from=2026-10-01&to=2026-10-10';
  for (const money of ['rates', 'none']) {
    const { ctx, out } = stubCtx(db, { access: { legacy: false, money, scope: { all: true, depts: [] }, views: [] }, query });
    assert.equal(payrollApi(ctx), true);
    assert.equal(out.status, 403);
  }
  const legacyNo = stubCtx(db, { access: { legacy: true, money: 'full' }, query });
  payrollApi(legacyNo.ctx);
  assert.equal(legacyNo.out.status, 403);
  const legacyYes = stubCtx(db, { access: { legacy: true, money: 'full' }, perms: ['reports:read'], query });
  payrollApi(legacyYes.ctx);
  assert.equal(legacyYes.out.status, 200);
  const full = stubCtx(db, { access: { legacy: false, money: 'full', scope: { all: true, depts: [] }, views: [] }, query });
  payrollApi(full.ctx);
  assert.equal(full.out.status, 200);
  assert.ok(full.out.body.rows.some(row => row.driverId === driverId));
  // Чужой маршрут не обрабатывается.
  const other = stubCtx(db, { access: { legacy: false, money: 'full' } });
  other.ctx.pathname = '/api/other';
  assert.equal(payrollApi(other.ctx), false);
});
