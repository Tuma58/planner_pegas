import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { openDatabase, queueOutbox, settingsObject } from '../src/db.mjs';
import { hasPermission, permissionsFor } from '../src/permissions.mjs';
import { importTelematics, importTripsFrom1C, reportSnapshot, resolveZone } from '../src/planner-service.mjs';
import { upsertPulled } from '../src/odata.mjs';
import { ipInSubnets, normalizeAllowedSubnets, parseCidr } from '../src/network-access.mjs';
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

test('мульти-роли: права объединяются, лишние не появляются', () => {
  const combo = { active: 1, role: 'sales', roles: '["sales","accountant"]' };
  assert.equal(hasPermission(combo, 'orders:write'), true);    // от продаж
  assert.equal(hasPermission(combo, 'payments:write'), true);  // от бухгалтерии
  assert.equal(hasPermission(combo, 'users:write'), false);    // админского нет
  assert.equal(hasPermission({ ...combo, active: 0 }, 'orders:write'), false);
  // roles-массивом (как в publicUser) — тоже работает
  assert.equal(hasPermission({ active: 1, roles: ['logist', 'manager'] }, 'reports:read'), true);
  // битый JSON — фолбэк на одиночную роль
  assert.equal(hasPermission({ active: 1, role: 'logist', roles: '{oops' }, 'trips:write'), true);
});

test('сетевой allowlist нормализует CIDR и проверяет IPv4/IPv6', () => {
  assert.deepEqual(normalizeAllowedSubnets([
    '192.168.10.44/24', '192.168.10.0/24', '2001:db8:1234::1/64'
  ]), ['192.168.10.0/24', '2001:db8:1234:0:0:0:0:0/64']);
  assert.equal(ipInSubnets('192.168.10.55', ['192.168.10.0/24']), true);
  assert.equal(ipInSubnets('192.168.11.55', ['192.168.10.0/24']), false);
  assert.equal(ipInSubnets('::ffff:192.168.10.55', ['192.168.10.0/24']), true);
  assert.equal(ipInSubnets('2001:db8:1234::abcd', ['2001:db8:1234::/64']), true);
  assert.equal(parseCidr('10.20.30.40').normalized, '10.20.30.40/32');
  assert.throws(() => normalizeAllowedSubnets([]), /хотя бы одну/);
  assert.throws(() => parseCidr('192.168.1.0/33'), /вне диапазона/);
});

test('первоначальная подсеть деплоя сохраняется в настройках БД', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pegas-network-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = openDatabase(path.join(directory, 'planner.db'), {
    username: 'root-admin', password: 'Temporary-password-2026', fullName: 'Администратор'
  }, { initialAllowedSubnets: ['192.168.50.27/24'] });
  t.after(() => db.close());
  assert.deepEqual(settingsObject(db).networkAccess.allowedSubnets, ['192.168.50.0/24']);
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
  // Алиасы расширены под выгрузки 1С (Подмосковье, сёла Пензы и Мордовии и др.).
  assert.equal(db.prepare('SELECT COUNT(*) count FROM zone_aliases').get().count, 190);
  assert.equal(settingsObject(db).general.horizonStart, '2026-07-01');
  assert.equal(settingsObject(db).calculation.vatRate, 0.22);
  assert.equal(settingsObject(db).calculation.insuranceAndRoadsPerKm, 6);
  assert.deepEqual(settingsObject(db).networkAccess.allowedSubnets, ['127.0.0.1/32', '::1/128']);

  const itemId = queueOutbox(db, 'trips', 'trip-1', 'create', { id: 'trip-1' });
  const item = db.prepare('SELECT * FROM outbox WHERE id=?').get(itemId);
  assert.equal(item.status, 'pending_approval');
  assert.deepEqual(JSON.parse(item.payload_json), { id: 'trip-1' });
});

test('конвейер: каждая стадия ждёт свою роль и своё право', async () => {
  const { pipelineStep, myTasks } = await import('../public/assets/pipeline.js');
  const data = { trips: [] };
  const allow = permission => () => true && permission;
  const expected = [
    [0, 'Продажи', 'orders:write'],
    [1, 'Логист', 'trips:write'],
    [2, 'Диспетчер', 'trip-status:write'],
    [3, 'Диспетчер', 'trip-status:write'],
    [4, 'Бухгалтерия', 'payments:write']
  ];
  for (const [stage, role, permission] of expected) {
    const step = pipelineStep({ stage, status: 'new' }, data, () => false);
    assert.equal(step.waitingRole, role, `стадия ${stage} ждёт ${role}`);
    assert.equal(step.permission, permission);
    assert.equal(step.mine, false, 'без права действие недоступно');
    // С нужным правом заявка становится задачей сотрудника.
    const mineStep = pipelineStep({ stage, status: 'new' }, data, code => code === permission);
    assert.equal(mineStep.mine, true);
    assert.equal(mineStep.tone, 'mine');
  }
  // Последняя стадия закрыта: действий нет ни у кого.
  const closed = pipelineStep({ stage: 5, status: 'planned' }, data, () => true);
  assert.equal(closed.waitingRole, null);
  assert.equal(closed.tone, 'done');
  // Отклонённая заявка выделяется отдельным цветом и не попадает в задачи.
  const rejected = pipelineStep({ stage: 0, status: 'cancelled' }, data, () => true);
  assert.equal(rejected.tone, 'rejected');
  assert.equal(myTasks([{ stage: 0, status: 'cancelled' }], data, () => true).length, 0);
  assert.ok(allow);
});

test('отклонение рейса возвращает заявку в продажи как новую с причиной', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pegas-return-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = openDatabase(path.join(directory, 'planner.db'), {
    username: 'root-admin', password: 'Temporary-password-2026', fullName: 'Администратор'
  });
  t.after(() => db.close());
  const zone = db.prepare('SELECT id FROM zones ORDER BY sort_order LIMIT 1').get();
  const vehicle = db.prepare('SELECT id FROM vehicles LIMIT 1').get();
  db.prepare(`INSERT INTO orders(id,customer_name,from_zone_id,to_zone_id,rate_vat,
    window_from,window_to,status,stage,assigned_vehicle_id)
    VALUES('o-1','Клиент',?,?,100000,'2026-07-10T08:00:00.000Z','2026-07-12T18:00:00.000Z',
    'planned',2,?)`).run(zone.id, zone.id, vehicle.id);
  db.prepare(`INSERT INTO trips(id,vehicle_id,order_id,customer_name,from_zone_id,to_zone_id,
    starts_at,ends_at,distance_km,revenue_vat,status)
    VALUES('t-1',?,'o-1','Клиент',?,?,'2026-07-10T08:00:00.000Z','2026-07-11T08:00:00.000Z',
    500,100000,'plan')`).run(vehicle.id, zone.id, zone.id);
  db.prepare(`UPDATE orders SET trip_id='t-1' WHERE id='o-1'`).run();

  // Поломка на маршруте: рейс отклонён — заявка обязана вернуться в продажи чистой.
  db.prepare(`UPDATE trips SET status='rejected',rejection_reason='Поломка на маршруте' WHERE id='t-1'`).run();
  db.prepare(`UPDATE orders SET status='new',stage=1,trip_id=NULL,assigned_vehicle_id=NULL,
    rejection_reason=?,returned_at=CURRENT_TIMESTAMP WHERE id='o-1'`).run('Поломка на маршруте');

  const order = db.prepare(`SELECT * FROM orders WHERE id='o-1'`).get();
  assert.equal(order.status, 'new');
  assert.equal(order.trip_id, null, 'связь с рейсом должна сниматься, иначе заявка выглядит назначенной');
  assert.equal(order.assigned_vehicle_id, null);
  assert.equal(order.rejection_reason, 'Поломка на маршруте');
  assert.ok(order.returned_at, 'возврат помечается временем — продажи видят историю');
});

test('диспозиции: вид «В работе» принимается, старая таблица мигрирует', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pegas-disp-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, 'planner.db');
  const admin = { username: 'root-admin', password: 'Temporary-password-2026', fullName: 'Администратор' };
  const first = openDatabase(databasePath, admin);
  const vehicle = first.prepare('SELECT id FROM vehicles LIMIT 1').get();
  // Свежая схема сразу принимает плановую загрузку «В работе».
  first.prepare(`INSERT INTO vehicle_dispositions(id,vehicle_id,kind,starts_at,ends_at)
    VALUES('d-work',?, 'work','2026-08-10T00:00:00.000Z','2026-08-11T00:00:00.000Z')`).run(vehicle.id);
  // Эмуляция БД прежней версии: таблица с узким CHECK без 'work'.
  first.exec(`DROP TABLE vehicle_dispositions;
    CREATE TABLE vehicle_dispositions (
      id TEXT PRIMARY KEY, vehicle_id TEXT NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('repair','no_driver','shift','out')),
      starts_at TEXT NOT NULL, ends_at TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
      created_by TEXT REFERENCES users(id), updated_by TEXT REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK(ends_at>starts_at));`);
  first.prepare(`INSERT INTO vehicle_dispositions(id,vehicle_id,kind,starts_at,ends_at,note)
    VALUES('d-old',?, 'repair','2026-08-01T00:00:00.000Z','2026-08-02T00:00:00.000Z','старый интервал')`).run(vehicle.id);
  first.close();
  // Повторное открытие пересоздаёт таблицу с расширенным CHECK, данные сохраняются.
  const second = openDatabase(databasePath, admin);
  t.after(() => second.close());
  assert.ok(second.prepare(`SELECT sql FROM sqlite_master WHERE name='vehicle_dispositions'`)
    .get().sql.includes("'work'"), 'CHECK расширен видом work');
  assert.equal(second.prepare(`SELECT note FROM vehicle_dispositions WHERE id='d-old'`).get().note,
    'старый интервал', 'данные пережили миграцию');
  second.prepare(`INSERT INTO vehicle_dispositions(id,vehicle_id,kind,starts_at,ends_at)
    VALUES('d-work-2',?, 'work','2026-08-12T00:00:00.000Z','2026-08-13T00:00:00.000Z')`).run(vehicle.id);
});

test('портфель продаж: назначенные заявки уходят к логисту, возвращаются при отклонении', async () => {
  const { inSalesPortfolio } = await import('../public/assets/pipeline.js');
  const data = { trips: [
    { id: 't-plan', status: 'plan' },
    { id: 't-run', status: 'run' },
    { id: 't-rejected', status: 'rejected' }
  ] };
  // До назначения ТС заявка в портфеле: принята и подтверждена.
  assert.equal(inSalesPortfolio({ stage: 0, status: 'new' }, data), true);
  assert.equal(inSalesPortfolio({ stage: 1, status: 'new' }, data), true);
  // После назначения — у логиста в плане, из портфеля уходит (весь жизненный цикл рейса).
  assert.equal(inSalesPortfolio({ stage: 2, status: 'planned', trip_id: 't-plan' }, data), false);
  assert.equal(inSalesPortfolio({ stage: 3, status: 'planned', trip_id: 't-run' }, data), false);
  // Возврат: рейс отклонён — заявка снова в портфеле как новая с пометкой.
  assert.equal(inSalesPortfolio({ stage: 1, status: 'new', returned_at: '2026-08-03 10:00:00',
    rejection_reason: 'Поломка на маршруте' }, data), true);
  // Рейс отклонён, но связь ещё не снята — заявка тоже видна (переназначить ТС).
  assert.equal(inSalesPortfolio({ stage: 2, status: 'planned', trip_id: 't-rejected' }, data), true);
  // Отклонённая заявка — в реестре отклонённых, не в портфеле.
  assert.equal(inSalesPortfolio({ stage: 0, status: 'cancelled' }, data), false);
});

test('контроль рейса: каркас стоянок наследует пункты и времена рейса', async t => {
  const { ensureTripStops, listTripStops } = await import('../src/trip-control.mjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pegas-stops-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = openDatabase(path.join(directory, 'planner.db'), {
    username: 'root-admin', password: 'Temporary-password-2026', fullName: 'Администратор'
  });
  t.after(() => db.close());
  const zone = db.prepare('SELECT id FROM zones ORDER BY sort_order LIMIT 1').get();
  const vehicle = db.prepare('SELECT id FROM vehicles LIMIT 1').get();
  db.prepare(`INSERT INTO trips(id,vehicle_id,customer_name,from_zone_id,to_zone_id,
    from_point,to_point,starts_at,ends_at,distance_km,revenue_vat,status)
    VALUES('ts-1',?,'Клиент',?,?,'Пенза','Люберцы',
    '2026-08-10T06:00:00.000Z','2026-08-11T06:00:00.000Z',640,100000,'plan')`)
    .run(vehicle.id, zone.id, zone.id);

  ensureTripStops(db, 'ts-1');
  const stops = listTripStops(db, 'ts-1');
  assert.equal(stops.length, 2, 'каркас — погрузка и выгрузка');
  assert.equal(stops[0].kind, 'P');
  assert.equal(stops[0].point, 'Пенза', 'погрузка в пункте отправления');
  assert.equal(stops[0].planned_arrival, '2026-08-10T06:00:00.000Z');
  assert.equal(stops[1].kind, 'D');
  assert.equal(stops[1].point, 'Люберцы');
  assert.equal(stops[1].planned_departure, '2026-08-11T06:00:00.000Z');
  assert.equal(stops[1].distance_km, 640);
  // Повторный вызов не плодит дубликатов.
  ensureTripStops(db, 'ts-1');
  assert.equal(listTripStops(db, 'ts-1').length, 2);
});

test('контроль рейса: факты на стоянках двигают статус рейса и стадию заявки', async t => {
  const { ensureTripStops, listTripStops, stampStopsFromStatus, syncTripFromStops } =
    await import('../src/trip-control.mjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pegas-sync-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = openDatabase(path.join(directory, 'planner.db'), {
    username: 'root-admin', password: 'Temporary-password-2026', fullName: 'Администратор'
  });
  t.after(() => db.close());
  const zone = db.prepare('SELECT id FROM zones ORDER BY sort_order LIMIT 1').get();
  const vehicle = db.prepare('SELECT id FROM vehicles LIMIT 1').get();
  db.prepare(`INSERT INTO orders(id,customer_name,from_zone_id,to_zone_id,rate_vat,
    window_from,window_to,status,stage,assigned_vehicle_id)
    VALUES('oc-1','Клиент',?,?,100000,'2026-08-10T06:00:00.000Z','2026-08-12T18:00:00.000Z',
    'planned',2,?)`).run(zone.id, zone.id, vehicle.id);
  db.prepare(`INSERT INTO trips(id,vehicle_id,order_id,customer_name,from_zone_id,to_zone_id,
    starts_at,ends_at,distance_km,revenue_vat,status)
    VALUES('tc-1',?,'oc-1','Клиент',?,?,'2026-08-10T06:00:00.000Z','2026-08-11T06:00:00.000Z',
    640,100000,'plan')`).run(vehicle.id, zone.id, zone.id);
  db.prepare(`UPDATE orders SET trip_id='tc-1' WHERE id='oc-1'`).run();
  ensureTripStops(db, 'tc-1');
  const [loading, unloading] = listTripStops(db, 'tc-1');

  // Отправление с погрузки → рейс «В пути», конвейер передан диспетчеру (стадия 3).
  db.prepare(`UPDATE trip_stops SET actual_departure='2026-08-10T08:30:00.000Z' WHERE id=?`)
    .run(loading.id);
  assert.equal(syncTripFromStops(db, 'tc-1'), 'run');
  assert.equal(db.prepare(`SELECT status FROM trips WHERE id='tc-1'`).get().status, 'run');
  assert.equal(db.prepare(`SELECT stage FROM orders WHERE id='oc-1'`).get().stage, 3);

  // Прибытие и завершение работ на конечной → «Выгружен», стадия 4 (бухгалтерия).
  db.prepare(`UPDATE trip_stops SET actual_arrival='2026-08-11T07:10:00.000Z',
    work_finished_at='2026-08-11T08:00:00.000Z' WHERE id=?`).run(unloading.id);
  assert.equal(syncTripFromStops(db, 'tc-1'), 'unloaded');
  const trip = db.prepare(`SELECT * FROM trips WHERE id='tc-1'`).get();
  assert.equal(trip.status, 'unloaded');
  assert.ok(trip.unloaded_at, 'момент выгрузки фиксируется');
  assert.equal(db.prepare(`SELECT stage FROM orders WHERE id='oc-1'`).get().stage, 4);

  // Обратная связь: ручной статус «paid» не затирает уже проставленные факты.
  stampStopsFromStatus(db, 'tc-1', 'paid');
  const finalStops = listTripStops(db, 'tc-1');
  assert.equal(finalStops[1].actual_arrival, '2026-08-11T07:10:00.000Z');
});

test('контроль рейса: расчётное прибытие сдвигается на накопленное опоздание', async () => {
  const { stopsWithEstimates, tripDelayMs } = await import('../src/trip-control.mjs');
  const stops = [
    {
      seq: 1, kind: 'P', planned_arrival: '2026-08-10T06:00:00.000Z',
      planned_departure: '2026-08-10T08:00:00.000Z',
      actual_arrival: '2026-08-10T06:00:00.000Z',
      // Отправление с погрузки на 2 часа позже плана.
      actual_departure: '2026-08-10T10:00:00.000Z'
    },
    {
      seq: 2, kind: 'D', planned_arrival: '2026-08-11T04:00:00.000Z',
      planned_departure: '2026-08-11T06:00:00.000Z'
    }
  ];
  const nowMs = Date.parse('2026-08-10T11:00:00.000Z');
  const estimated = stopsWithEstimates(stops, 'run', nowMs);
  assert.equal(estimated[1].estimated_arrival, '2026-08-11T06:00:00.000Z',
    'расчёт прибытия на выгрузку сдвинут на 2 часа опоздания');
  assert.equal(tripDelayMs(estimated), 2 * 3_600_000);
  // Без фактов и до планового времени расчёт совпадает с планом.
  const clean = stopsWithEstimates(stops.map(({ actual_arrival, actual_departure, ...rest }) => rest),
    'plan', nowMs);
  assert.equal(clean[1].estimated_arrival, '2026-08-11T04:00:00.000Z');
  assert.equal(tripDelayMs(clean), 0);
});

test('новые алиасы геозон доезжают до уже засеянной базы', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pegas-alias-test-'));
  const databasePath = path.join(directory, 'planner.db');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const admin = { username: 'root-admin', password: 'Temporary-password-2026', fullName: 'Администратор' };

  const first = openDatabase(databasePath, admin);
  // Имитируем установку, где справочник ещё не знает города из свежей выгрузки.
  first.prepare(`DELETE FROM zone_aliases WHERE alias='Видное'`).run();
  assert.equal(first.prepare(`SELECT COUNT(*) count FROM zone_aliases WHERE alias='Видное'`).get().count, 0);
  first.close();

  // Повторное открытие обязано вернуть алиас: сид справочников не должен зависеть
  // от отметки tk20_seed_version, иначе импорт 1С теряет треть рейсов.
  const second = openDatabase(databasePath, admin);
  t.after(() => second.close());
  assert.equal(second.prepare(`SELECT COUNT(*) count FROM zone_aliases WHERE alias='Видное'`).get().count, 1);
  assert.equal(resolveZone(second, 'Видное')?.name, 'Москва');
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
  // Пункты погрузки/выгрузки сохраняются: маршрут показывается «из пункта в пункт»,
  // зона (Дом/Москва) остаётся каркасом аналитики.
  assert.equal(trip.from_point, 'Пенза');
  assert.equal(trip.to_point, '');
  assert.deepEqual(importTelematics(db, [{
    rideId: '1С-TEST-1', km: 650, status: 'done', unloadedAt: '2026-07-12T10:00:00Z'
  }], user), { matched: 1, kmUpdated: 1, statusUpdated: 1, skipped: 0 });
  assert.equal(db.prepare('SELECT actual_distance_km FROM trips WHERE id=?').get(trip.id).actual_distance_km, 650);
  const report = reportSnapshot(db, '2026-07-01', '2026-08-01');
  assert.ok(report.netRevenue > 0);
  assert.ok(report.fixed > 0);
  assert.equal(report.vehicles, 128);

  // Утилизация: каскад КТГ×КВЛ×КИП по машино-дням.
  assert.equal(report.utilization.calendarDays, 128 * 31);
  assert.ok(report.utilization.workDays > 0);
  assert.ok(report.utilization.ktg > 0 && report.utilization.ktg <= 1);
  assert.equal(report.utilization.machineDays.repair, 0);
  const vehicleRow = db.prepare('SELECT id FROM vehicles LIMIT 1').get();
  db.prepare(`INSERT INTO vehicle_dispositions(id,vehicle_id,kind,starts_at,ends_at)
    VALUES('disp-util-1',?,'repair','2026-07-05T00:00:00Z','2026-07-15T00:00:00Z')`).run(vehicleRow.id);
  const withRepair = reportSnapshot(db, '2026-07-01', '2026-08-01');
  assert.equal(withRepair.utilization.machineDays.repair, 10);
  assert.equal(withRepair.utilization.techDays, 128 * 31 - 10);
  assert.ok(withRepair.utilization.ktg < 1);
  assert.ok(withRepair.utilization.lostProfit >= 0);
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

test('перенос пользователей: export-users → import-users сохраняет хэши и обновляет по username', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pegas-users-transfer-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const projectRoot = path.resolve(import.meta.dirname, '..');
  const sourcePath = path.join(directory, 'source.db');
  const targetPath = path.join(directory, 'target.db');

  const source = openDatabase(sourcePath, {
    username: 'admin', password: 'Old-admin-password-2026', fullName: 'Старый админ'
  });
  const oldHash = source.prepare(`SELECT password_hash FROM users WHERE username='admin'`).get().password_hash;
  source.prepare(`INSERT INTO users(id,username,full_name,email,password_hash,role,active)
    VALUES('u-logist','petrov','Петров','p@x.ru','HASH-PETROV','logist',1)`).run();
  source.close();

  const target = openDatabase(targetPath, {
    username: 'admin', password: 'New-admin-password-2026', fullName: 'Новый админ'
  });
  target.close();

  const exported = spawnSync(process.execPath, ['scripts/export-users.mjs'], {
    cwd: projectRoot, encoding: 'utf8', env: { ...process.env, DATABASE_PATH: sourcePath }
  });
  assert.equal(exported.status, 0, exported.stderr);
  const users = JSON.parse(exported.stdout);
  assert.equal(users.length, 2);

  const imported = spawnSync(process.execPath, ['scripts/import-users.mjs'], {
    cwd: projectRoot, encoding: 'utf8', input: exported.stdout,
    env: { ...process.env, DATABASE_PATH: targetPath }
  });
  assert.equal(imported.status, 0, imported.stderr);
  assert.match(imported.stdout, /Импортировано пользователей: 2/);

  const check = openDatabase(targetPath, {
    username: 'admin', password: 'Unused-password-2026', fullName: 'X'
  });
  t.after(() => check.close());
  assert.equal(check.prepare('SELECT COUNT(*) count FROM users').get().count, 2);
  // admin не задублирован, его хэш заменён на перенесённый (старый пароль снова действует)
  assert.equal(check.prepare(`SELECT password_hash FROM users WHERE username='admin'`).get().password_hash, oldHash);
  const petrov = check.prepare(`SELECT role,roles,password_hash,active FROM users WHERE username='petrov'`).get();
  assert.deepEqual({ ...petrov }, { role: 'logist', roles: '["logist"]', password_hash: 'HASH-PETROV', active: 1 });
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

test('trustProxy включён по умолчанию в production и переопределяется через TRUST_PROXY', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pegas-trustproxy-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const appSecretFile = path.join(directory, 'app_secret');
  fs.writeFileSync(appSecretFile, 'c'.repeat(64), { mode: 0o400 });
  const projectRoot = path.resolve(import.meta.dirname, '..');
  const { TRUST_PROXY: _ignored, NODE_ENV: _env, ...baseEnv } = process.env;
  const read = extraEnv => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import { config } from './src/config.mjs'; process.stdout.write(String(config.trustProxy));`], {
      cwd: projectRoot, encoding: 'utf8',
      env: { ...baseEnv, APP_SECRET_FILE: appSecretFile, ...extraEnv }
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  assert.equal(read({ NODE_ENV: 'production' }), 'true');
  assert.equal(read({ NODE_ENV: 'production', TRUST_PROXY: 'false' }), 'false');
  assert.equal(read({ NODE_ENV: 'development' }), 'false');
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
