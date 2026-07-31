import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { openDatabase, queueOutbox, settingsObject } from '../src/db.mjs';
import { hasPermission, permissionsFor } from '../src/permissions.mjs';
import { importTelematics, importTripsFrom1C, reportSnapshot } from '../src/planner-service.mjs';
import { upsertPulled } from '../src/odata.mjs';
import { decryptSecret, encryptSecret, hashPassword, verifyPassword } from '../src/security.mjs';

test('пароли хешируются, а секреты 1С шифруются', () => {
  const password = 'Very-strong-password-2026';
  const hash = hashPassword(password);
  assert.notEqual(hash, password);
  assert.equal(verifyPassword(password, hash), true);
  assert.equal(verifyPassword('wrong-password', hash), false);

  const encrypted = encryptSecret('odata-password', 'application-secret');
  assert.notEqual(encrypted, 'odata-password');
  assert.equal(decryptSecret(encrypted, 'application-secret'), 'odata-password');
});

test('матрица ролей не дает обычной роли административных прав', () => {
  assert.equal(hasPermission({ active: 1, role: 'admin' }, 'users:write'), true);
  assert.equal(hasPermission({ active: 1, role: 'logist' }, 'users:write'), false);
  assert.equal(hasPermission({ active: 1, role: 'logist' }, 'trips:write'), true);
  assert.equal(permissionsFor('unknown').length, 0);
});

test('SQLite создается со справочниками, администратором и outbox', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pegas-planner-test-'));
  const databasePath = path.join(directory, 'planner.db');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = openDatabase(databasePath, {
    username: 'root-admin',
    password: 'Temporary-password-2026',
    fullName: 'Тестовый администратор'
  });
  t.after(() => db.close());

  assert.equal(db.prepare('SELECT COUNT(*) count FROM users').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM zones').get().count, 10);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM vehicles').get().count, 127);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM trips').get().count, 1651);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM customers').get().count, 109);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM zone_aliases').get().count, 54);
  assert.equal(settingsObject(db).general.horizonStart, '2026-07-01');
  assert.equal(settingsObject(db).calculation.vatRate, 0.22);
  assert.equal(settingsObject(db).calculation.insuranceAndRoadsPerKm, 6);

  const itemId = queueOutbox(db, 'trips', 'trip-1', 'create', { id: 'trip-1' });
  const item = db.prepare('SELECT * FROM outbox WHERE id=?').get(itemId);
  assert.equal(item.status, 'pending_approval');
  assert.deepEqual(JSON.parse(item.payload_json), { id: 'trip-1' });
});

test('контракты 1С и телематики идемпотентны, отчет использует новую экономику', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pegas-contract-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = openDatabase(path.join(directory, 'planner.db'), {
    username: 'root-admin', password: 'Temporary-password-2026', fullName: 'Администратор'
  });
  t.after(() => db.close());
  const user = db.prepare('SELECT * FROM users LIMIT 1').get();
  const row = {
    id: '1С-TEST-1', zoneFrom: 'Пенза', zoneTo: 'Москва', truck: 'а001аа58',
    client: 'Тестовый ИП', depDate: '2026-07-10', doneDate: '2026-07-12',
    revenue: 100000, status: 'plan'
  };
  assert.deepEqual(importTripsFrom1C(db, [row], user), {
    imported: 1, updated: 0, skipped: 0, errors: []
  });
  assert.equal(importTripsFrom1C(db, [{ ...row, revenue: 120000 }], user).updated, 1);
  const trip = db.prepare(`SELECT * FROM trips WHERE external_id='1c:1С-TEST-1'`).get();
  assert.equal(trip.revenue_vat, 120000);
  assert.deepEqual(importTelematics(db, [{
    rideId: '1С-TEST-1', km: 650, status: 'done', unloadedAt: '2026-07-12T10:00:00Z'
  }], user), { matched: 1, kmUpdated: 1, statusUpdated: 1, skipped: 0 });
  assert.equal(db.prepare('SELECT actual_distance_km FROM trips WHERE id=?').get(trip.id).actual_distance_km, 650);
  const report = reportSnapshot(db, '2026-07-01', '2026-08-01');
  assert.ok(report.netRevenue > 0);
  assert.ok(report.fixed > 0);
  assert.equal(report.vehicles, 128);
});

test('OData upsert принимает поля ТК 20 и короткие статусы', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pegas-odata-tk20-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = openDatabase(path.join(directory, 'planner.db'), {
    username: 'root-admin', password: 'Temporary-password-2026', fullName: 'Администратор'
  });
  t.after(() => db.close());
  const vehicle = db.prepare('SELECT plate FROM vehicles LIMIT 1').get();
  assert.equal(upsertPulled(db, 'orders', {
    externalId: 'order-tk20', customerName: 'Тест', fromZone: 'Пенза', toZone: 'Москва',
    rateVat: 90000, windowFrom: '2026-07-15', windowTo: '2026-07-17',
    status: 'new', temperatureMode: '0…+4 °C', bodyType: 'Рефрижератор'
  }), 1);
  assert.equal(upsertPulled(db, 'trips', {
    externalId: 'trip-tk20', vehicle: vehicle.plate, customerName: 'Тест',
    fromZone: 'Пенза', toZone: 'Москва', startsAt: '2026-07-15',
    endsAt: '2026-07-17', distanceKm: 640, revenueVat: 90000,
    status: 'unl', temperatureMode: '0…+4 °C', bodyType: 'Рефрижератор'
  }), 1);
  const trip = db.prepare(`SELECT * FROM trips WHERE external_id='trip-tk20'`).get();
  assert.equal(trip.status, 'unloaded');
  assert.equal(trip.temperature_mode, '0…+4 °C');
  assert.equal(trip.source_system, '1c');
});

test('production-конфигурация читает Docker secrets из файлов', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pegas-secrets-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const appSecretFile = path.join(directory, 'app_secret');
  const passwordFile = path.join(directory, 'admin_password');
  fs.writeFileSync(appSecretFile, 'a'.repeat(64), { mode: 0o400 });
  fs.writeFileSync(passwordFile, 'Initial-admin-password-2026', { mode: 0o400 });
  const projectRoot = path.resolve(import.meta.dirname, '..');
  const script = `import { config } from './src/config.mjs';
    process.stdout.write(JSON.stringify({
      secret:config.appSecret,password:config.admin.password,secureCookies:config.secureCookies
    }));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: {
      ...process.env, NODE_ENV: 'production',
      APP_SECRET_FILE: appSecretFile, ADMIN_PASSWORD_FILE: passwordFile
    }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    secret: 'a'.repeat(64), password: 'Initial-admin-password-2026', secureCookies: true
  });
});

test('LAN production допускает явное отключение Secure cookie только через настройку', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pegas-lan-config-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const appSecretFile = path.join(directory, 'app_secret');
  fs.writeFileSync(appSecretFile, 'b'.repeat(64), { mode: 0o400 });
  const projectRoot = path.resolve(import.meta.dirname, '..');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { config } from './src/config.mjs'; process.stdout.write(String(config.secureCookies));`], {
    cwd: projectRoot, encoding: 'utf8',
    env: {
      ...process.env, NODE_ENV: 'production', COOKIE_SECURE: 'false',
      APP_SECRET_FILE: appSecretFile
    }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'false');
});
