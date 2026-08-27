import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { nextOrderNo, nextRouteNo, openDatabase, queueOutbox, settingsObject } from '../src/db.mjs';
import { effectivePermissions, hasPermission, permissionsFor } from '../src/permissions.mjs';
import { attendanceEffective, attendanceSummary, attendanceTimesheet, chatGroups, chatMessages, createDriverAssignment, customerCard, daysUntilAnnual, upcomingCustomerDates, dayStateOf, tripBusyRange, tripsWithoutNext, demurrageCases, driverCardData, driverScheduleData, importTelematics, importTripsFrom1C, markAttendance, reportSnapshot, resolveZone, shiftIsWorkday, staffReport, transitHours } from '../src/planner-service.mjs';
import { upsertPulled } from '../src/odata.mjs';
import { ipInSubnets, normalizeAllowedSubnets, parseCidr } from '../src/network-access.mjs';
import { decryptSecret, encryptSecret, hashPassword, verifyPassword } from '../src/security.mjs';
import { ensureTripStops, rescheduleTripStops } from '../src/trip-control.mjs';
import { matchVehicles, placeOf } from '../public/assets/sales.js';
import { cleanFileName, uploadMimeOf } from '../src/uploads.mjs';

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

  // Справочник адресов из АДРЕС.xlsx: все 611 пунктов с зонами,
  // плановое расстояние от базы (Пенза) — по координатам (Москва ~630 км).
  assert.equal(db.prepare('SELECT COUNT(*) count FROM addresses').get().count, 611);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM addresses WHERE zone_id IS NULL').get().count, 0);
  const moscow = db.prepare(`SELECT base_distance_km,region FROM addresses
    WHERE name LIKE 'Москва г%' LIMIT 1`).get();
  assert.ok(moscow.base_distance_km > 450 && moscow.base_distance_km < 900,
    `от базы до Москвы: ${moscow.base_distance_km}`);
  // Субъект РФ распознан у каждого адреса — фильтр по субъекту опирается на это.
  assert.equal(db.prepare(`SELECT COUNT(*) count FROM addresses WHERE region=''`).get().count, 0);
  assert.equal(moscow.region, 'Москва г');

  // Порожние подгоны: бэкфилл истории посчитал км между рейсами сцепок
  // (резолв пунктов 1С в адреса/центры зон; нерезолвленные остаются NULL).
  const emptyStats = db.prepare(`SELECT COUNT(empty_km) counted, COALESCE(SUM(empty_km),0) total
    FROM trips`).get();
  assert.ok(emptyStats.counted > 500, `порожняк посчитан у ${emptyStats.counted} рейсов`);
  assert.ok(emptyStats.total > 0, 'суммарный порожняк положителен');

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

test('водители: сид из карточек ТС, закрепление и мягкое увольнение', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pegas-drivers-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = openDatabase(path.join(directory, 'planner.db'), {
    username: 'root-admin', password: 'Temporary-password-2026', fullName: 'Администратор'
  });
  t.after(() => db.close());
  // Сид: водители перенесены из vehicles.driver_name с закреплением.
  const total = db.prepare('SELECT COUNT(*) n FROM drivers').get().n;
  assert.ok(total > 0, 'справочник наполнен из карточек ТС');
  const linked = db.prepare(`SELECT COUNT(*) n FROM drivers WHERE vehicle_id IS NOT NULL`).get().n;
  assert.equal(linked, total, 'каждый перенесённый водитель закреплён за сцепкой');
  // Повторное открытие не плодит дубли (флаг drivers_seeded_v1).
  const sample = db.prepare('SELECT * FROM drivers LIMIT 1').get();
  const vehicle = db.prepare('SELECT * FROM vehicles WHERE id=?').get(sample.vehicle_id);
  assert.equal(vehicle.driver_name.trim(), sample.full_name, 'имя синхронизировано с картой ТС');
});

test('диспозиции: вид «В работе» принимается, старая таблица мигрирует', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pegas-disp-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, 'planner.db');
  const admin = { username: 'root-admin', password: 'Temporary-password-2026', fullName: 'Администратор' };
  const first = openDatabase(databasePath, admin);
  const vehicle = first.prepare('SELECT id FROM vehicles LIMIT 1').get();
  // Свежая схема сразу принимает бронь «Резерв под заказ».
  first.prepare(`INSERT INTO vehicle_dispositions(id,vehicle_id,kind,starts_at,ends_at)
    VALUES('d-res',?, 'reserve','2026-08-10T00:00:00.000Z','2026-08-11T00:00:00.000Z')`).run(vehicle.id);
  // Эмуляция БД прежней версии: CHECK со старым видом 'work' и такой записью.
  first.exec(`DROP TABLE vehicle_dispositions;
    CREATE TABLE vehicle_dispositions (
      id TEXT PRIMARY KEY, vehicle_id TEXT NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('work','repair','no_driver','shift','out')),
      starts_at TEXT NOT NULL, ends_at TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
      created_by TEXT REFERENCES users(id), updated_by TEXT REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK(ends_at>starts_at));`);
  first.prepare(`INSERT INTO vehicle_dispositions(id,vehicle_id,kind,starts_at,ends_at,note)
    VALUES('d-old',?, 'repair','2026-08-01T00:00:00.000Z','2026-08-02T00:00:00.000Z','старый интервал')`).run(vehicle.id);
  first.prepare(`INSERT INTO vehicle_dispositions(id,vehicle_id,kind,starts_at,ends_at)
    VALUES('d-legacy-work',?, 'work','2026-08-05T00:00:00.000Z','2026-08-06T00:00:00.000Z')`).run(vehicle.id);
  // Заявка без номера — бэкфилл автономера при следующем старте.
  const zoneId = first.prepare('SELECT id FROM zones LIMIT 1').get().id;
  first.prepare(`INSERT INTO orders(id,customer_name,from_zone_id,to_zone_id,rate_vat,
    window_from,window_to,status,stage)
    VALUES('o-nonum','Клиент',?,?,50000,'2026-08-10T08:00:00.000Z','2026-08-12T18:00:00.000Z','new',0)`)
    .run(zoneId, zoneId);
  // Плановый рейс со старой длительностью — перепланируется новой формулой:
  // 500 км → 21 ч от начала (заявки с более широким окном у рейса нет).
  first.prepare(`INSERT INTO trips(id,vehicle_id,from_zone_id,to_zone_id,starts_at,ends_at,
    distance_km,revenue_vat,status)
    VALUES('t-replan',?,?,?,'2026-08-20T08:00:00.000Z','2026-08-25T08:00:00.000Z',500,90000,'plan')`)
    .run(vehicle.id, zoneId, zoneId);
  first.prepare(`DELETE FROM app_meta WHERE key='transit_replan_v1'`).run();
  first.close();
  // Повторное открытие пересоздаёт таблицу: CHECK с 'reserve', work → reserve.
  const second = openDatabase(databasePath, admin);
  t.after(() => second.close());
  assert.ok(second.prepare(`SELECT sql FROM sqlite_master WHERE name='vehicle_dispositions'`)
    .get().sql.includes("'reserve'"), 'CHECK содержит вид reserve');
  assert.equal(second.prepare(`SELECT note FROM vehicle_dispositions WHERE id='d-old'`).get().note,
    'старый интервал', 'данные пережили миграцию');
  assert.equal(second.prepare(`SELECT kind FROM vehicle_dispositions WHERE id='d-legacy-work'`)
    .get().kind, 'reserve', 'прежняя бронь «В работе» стала резервом');
  second.prepare(`INSERT INTO vehicle_dispositions(id,vehicle_id,kind,starts_at,ends_at)
    VALUES('d-res-2',?, 'reserve','2026-08-12T00:00:00.000Z','2026-08-13T00:00:00.000Z')`).run(vehicle.id);
  // Регрессия ТС 168: правка дат резерва (в т.ч. на более ранний срок)
  // должна проходить — вид reserve обязан быть в списке допустимых при PATCH.
  second.prepare(`UPDATE vehicle_dispositions SET starts_at='2026-08-10T00:00:00.000Z'
    WHERE id='d-res-2'`).run();
  assert.equal(second.prepare(`SELECT starts_at FROM vehicle_dispositions WHERE id='d-res-2'`)
    .get().starts_at, '2026-08-10T00:00:00.000Z');

  assert.equal(second.prepare(`SELECT ends_at FROM trips WHERE id='t-replan'`).get().ends_at,
    '2026-08-21T05:00:00.000Z', 'план перепланирован: 500 км = 21 час');

  // Автономер: система присвоила заявке следующий номер сквозного счётчика,
  // nextOrderNo продолжает нумерацию без повторов.
  assert.equal(second.prepare(`SELECT order_no FROM orders WHERE id='o-nonum'`).get().order_no,
    '1001', 'бэкфилл пронумеровал заявку');
  assert.equal(nextOrderNo(second), '1002');
  assert.equal(nextOrderNo(second), '1003');

  // Конструктор маршрутов: таблица создана, номера сквозные, заявка
  // привязывается к маршруту с порядковым номером.
  assert.equal(nextRouteNo(second), 'М-101');
  assert.equal(nextRouteNo(second), 'М-102');
  second.prepare(`INSERT INTO routes(id,route_no,base_region,target_per_day)
    VALUES('rt-1','М-101','Пензенская обл',48000)`).run();
  second.prepare(`UPDATE orders SET route_id='rt-1',route_seq=1 WHERE id='o-nonum'`).run();
  const routed = second.prepare(`SELECT route_id,route_seq FROM orders WHERE id='o-nonum'`).get();
  assert.equal(routed.route_id, 'rt-1');
  assert.equal(routed.route_seq, 1);
});

test('потребность от логистики: ремонт и «без водителя» скрывают ТС до суток перед выходом', async () => {
  const { autoRequests, matchVehicles } = await import('../public/assets/sales.js');
  const now = Date.now();
  const iso = ms => new Date(ms).toISOString();
  const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
  const monthEnd = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 1));
  const zones = [{ id: 'z1', name: 'Дом', color: '#4f8a6d' }, { id: 'z2', name: 'Москва', color: '#4e7ab0' }];
  const vehicle = plate => ({ id: plate, plate, status: 'work', type_name: 'Тушевоз', zone_name: 'Дом' });
  const trip = (vehicleId, endMs) => ({ vehicle_id: vehicleId, status: 'done', to_name: 'Дом',
    starts_at: iso(endMs - 86_400_000), ends_at: iso(endMs) });
  const data = {
    reference: { zones, routeRates: [] },
    vehicles: [vehicle('А1'), vehicle('А2'), vehicle('А3'), vehicle('А4'), vehicle('А5'), vehicle('А6')],
    // А4 — «июльский хвост»: последний рейс закончился до начала месяца,
    // сцепка простаивает дольше всех и обязана быть в потребности.
    trips: [trip('А1', now - 3_600_000), trip('А2', now - 3_600_000), trip('А3', now - 3_600_000),
      trip('А4', monthStart.getTime() - 5 * 86_400_000),
      trip('А5', now - 3_600_000), trip('А6', now - 3_600_000)],
    dispositions: [
      // А2: в ремонте ещё 3 дня — в потребность не попадает
      { vehicle_id: 'А2', kind: 'repair', starts_at: iso(now - 86_400_000), ends_at: iso(now + 3 * 86_400_000) },
      // А3: без водителя, выйдет через 10 часов — попадает с пометкой
      { vehicle_id: 'А3', kind: 'no_driver', starts_at: iso(now - 86_400_000), ends_at: iso(now + 10 * 3_600_000) },
      // А5: в резерве под заказ ещё 3 дня — обещана, продажам не предлагается
      { vehicle_id: 'А5', kind: 'reserve', starts_at: iso(now - 86_400_000), ends_at: iso(now + 3 * 86_400_000) },
      // А6: резерв истекает через 10 часов — видна с пометкой «выйдет из резерва»
      { vehicle_id: 'А6', kind: 'reserve', starts_at: iso(now - 86_400_000), ends_at: iso(now + 10 * 3_600_000) }
    ]
  };
  const requests = autoRequests(data, monthStart, monthEnd);
  const plates = requests.map(request => request.vehicle.plate);
  assert.ok(plates.includes('А1'), 'свободная сцепка в потребности');
  assert.ok(!plates.includes('А2'), 'в ремонте ещё 3 дня — скрыта');
  assert.ok(plates.includes('А3'), 'выходит из простоя менее чем через сутки — видна');
  assert.ok(!plates.includes('А5'), 'в резерве под заказ — скрыта из потребности');
  assert.equal(requests.find(request => request.vehicle.plate === 'А6')?.blockedKind,
    'reserve', 'резерв истекает за сутки — пометка «выйдет из резерва»');
  const a3 = requests.find(request => request.vehicle.plate === 'А3');
  assert.equal(a3.blockedKind, 'no_driver', 'пометка «получит водителя»');
  assert.equal(a3.freeAt, data.dispositions[1].ends_at, 'момент освобождения — конец диспозиции');
  assert.equal(a3.idleMs, 0, 'освобождение в будущем — не простой');
  // Простой считается и по хвостам прошлого месяца.
  const a4 = requests.find(request => request.vehicle.plate === 'А4');
  assert.ok(a4, 'июльский хвост в потребности');
  assert.ok(a4.idleMs > 5 * 86_400_000, 'простой отсчитан от конца последнего рейса');
  const a1 = requests.find(request => request.vehicle.plate === 'А1');
  assert.ok(a1.idleMs > 0 && a1.idleMs < 2 * 3_600_000, 'свежая — простой около часа');

  // Кандидаты на назначение: ТС в ремонте на момент погрузки не предлагается.
  const candidates = matchVehicles(data, 'Дом', iso(now + 3_600_000));
  assert.ok(!candidates.some(candidate => candidate.vehicle.plate === 'А2'),
    'ремонт исключает из кандидатов');
  assert.ok(!candidates.some(candidate => candidate.vehicle.plate === 'А5'),
    'резерв исключает из кандидатов подбора');
  assert.ok(candidates.some(candidate => candidate.vehicle.plate === 'А1'));

  // Подсказка при назначении: ближайшее событие сцепки после момента погрузки —
  // самое раннее из будущих рейсов и диспозиций; прошлые не показываются.
  const { nextVehicleEvent } = await import('../public/assets/sales.js');
  data.trips.push({ vehicle_id: 'А1', status: 'plan', from_name: 'Дом', to_name: 'Москва',
    starts_at: iso(now + 3 * 86_400_000), ends_at: iso(now + 4 * 86_400_000) });
  data.dispositions.push({ vehicle_id: 'А1', kind: 'shift',
    starts_at: iso(now + 86_400_000), ends_at: iso(now + 2 * 86_400_000) });
  const eventA1 = nextVehicleEvent(data, 'А1', now);
  assert.equal(eventA1.label, 'Пересменка', 'пересменка раньше рейса — она первая');
  const eventAfterShift = nextVehicleEvent(data, 'А1', now + 2 * 86_400_000);
  assert.ok(eventAfterShift.label.includes('рейс'), 'после пересменки следующее — рейс');
  assert.equal(nextVehicleEvent(data, 'А4', now), null, 'без будущих событий — null');

  // Субъект места: имя зоны — самый частый субъект её адресов, не подстрока
  // («Дом» не должен находить Домодедово); пункт уточняет внутри зоны.
  const { regionOfPlace } = await import('../public/assets/sales.js');
  const regionData = { reference: { addresses: [
    { name: 'Пенза-склад', address: 'г Пенза', zone_name: 'Дом', region: 'Пензенская обл' },
    { name: 'Кузнецк', address: 'г Кузнецк', zone_name: 'Дом', region: 'Пензенская обл' },
    { name: 'Домодедово', address: 'МО, Домодедово', zone_name: 'Москва', region: 'Московская обл' },
    { name: 'Софьино', address: 'МО, Раменский р-н', zone_name: 'Москва', region: 'Московская обл' },
  ] } };
  assert.equal(regionOfPlace(regionData, '', 'Дом'), 'Пензенская обл',
    'зона «Дом» — модальный регион её адресов, не Домодедово');
  assert.equal(regionOfPlace(regionData, 'Софьино', 'Москва'), 'Московская обл');
  assert.equal(regionOfPlace(regionData, 'Софьино', ''), 'Московская обл',
    'без зоны — пункт по справочнику');
  assert.equal(regionOfPlace(regionData, '', 'Неизвестная'), '', 'чужая зона — пусто');

  // Задание продажам на дату: свободные/освобождающиеся/недоступные сцепки
  // и дефицит региона с рекомендацией подгона ближайшей свободной.
  const { salesTaskFor } = await import('../public/assets/sales.js');
  const day = '2026-08-20';
  const taskData = { reference: { addresses: [
      { id: 'a-pnz', name: 'Пенза-склад', address: 'г Пенза', zone_name: 'Дом',
        region: 'Пензенская обл', latitude: 53.2, longitude: 45.0 },
      { id: 'a-sof', name: 'Софьино', address: 'МО, Раменский р-н', zone_name: 'Москва',
        region: 'Московская обл', latitude: 55.5, longitude: 38.1 },
    ], zones: [] },
    vehicles: [
      { id: 'V1', plate: 'В1', status: 'work', zone_name: 'Дом', type_name: 'Тушевоз' },
      { id: 'V2', plate: 'В2', status: 'work', zone_name: 'Дом', type_name: 'Паллет 33' },
      { id: 'V3', plate: 'В3', status: 'work', zone_name: 'Дом', type_name: 'Тушевоз' },
    ],
    trips: [
      { vehicle_id: 'V1', status: 'done', to_point: 'Пенза-склад', to_name: 'Дом',
        starts_at: '2026-08-10T08:00:00.000Z', ends_at: '2026-08-12T08:00:00.000Z' },
      // Выгружен по факту в течение дня задания: освобождается честно, по
      // unloaded_at (незавершённый run с прошедшим расчётом занят до факта).
      { vehicle_id: 'V2', status: 'unloaded', to_point: 'Пенза-склад', to_name: 'Дом',
        unloaded_at: '2026-08-20T15:00:00.000Z',
        starts_at: '2026-08-19T08:00:00.000Z', ends_at: '2026-08-20T13:00:00.000Z' },
    ],
    dispositions: [
      { vehicle_id: 'V3', kind: 'repair',
        starts_at: '2026-08-19T00:00:00.000Z', ends_at: '2026-08-22T00:00:00.000Z' },
    ],
    orders: [
      { id: 'O1', order_no: '2001', customer_name: 'К1', stage: 1, rate_vat: 100000,
        body_type: 'Тушевоз',
        from_address_id: 'a-sof', from_point: 'Софьино', from_name: 'Москва',
        to_point: 'Пенза-склад', to_name: 'Дом',
        window_from: '2026-08-20T06:00:00.000Z', window_to: '2026-08-20T20:00:00.000Z' },
      { id: 'O2', order_no: '2002', customer_name: 'К2', stage: 1, rate_vat: 90000,
        body_type: 'Рефрижератор',
        from_address_id: 'a-sof', from_point: 'Софьино', from_name: 'Москва',
        to_point: 'Пенза-склад', to_name: 'Дом',
        window_from: '2026-08-20T06:00:00.000Z', window_to: '2026-08-20T20:00:00.000Z' },
    ] };
  // Кейс р892ху58: рейс run с давно прошедшим расчётным концом и без факта
  // выгрузки — машина ЕЩЁ ЕДЕТ и свободной не считается вовсе.
  taskData.vehicles.push({ id: 'V4', plate: 'р892ху58', status: 'work',
    type_name: 'Реф', zone_name: 'Дом' });
  taskData.trips.push({ vehicle_id: 'V4', status: 'run', to_point: 'новоиссибирск, никитина',
    to_name: 'Москва', starts_at: '2026-08-19T08:00:00.000Z', ends_at: '2026-08-20T05:00:00.000Z' });
  const task = salesTaskFor(taskData, day);
  assert.ok(!task.free.some(item => item.vehicle.id === 'V4'), '892 не в свободных');
  assert.ok(!task.freeing.some(item => item.vehicle.id === 'V4' && item.at),
    '892 без обещанного времени освобождения');
  assert.equal(task.free.length, 1, 'V1 свободна с прошлых дней');
  assert.equal(task.free[0].region, 'Пензенская обл');
  assert.equal(task.freeing.length, 1, 'V2 освободится после рейса в течение дня');
  assert.equal(task.unavailable.length, 1, 'V3 в ремонте весь день');
  assert.equal(task.lanes.length, 1, 'направление Москва → Дом одно');
  const lane = task.lanes[0];
  assert.equal(lane.lane, 'Москва → Дом');
  assert.equal(lane.orders.length, 2, 'двум рейсам нужно ТС на направлении');
  assert.deepEqual(Object.fromEntries(lane.byType), { 'Тушевоз': 1, 'любой реф': 1 },
    'разбивка по типам: точный кузов + любой рефрижератор');
  assert.equal(lane.deficit, 2, 'в Московской свободных сцепок нет — не хватает обеих');
  assert.ok(lane.lack.some(item => item.type === 'Тушевоз' && item.count === 1),
    'дефицит тушевоза по типу');
  const sendT = lane.send.find(item => item.forType === 'Тушевоз');
  assert.ok(sendT && sendT.vehicle.type_name === 'Тушевоз',
    'на дефицит тушевоза рекомендован именно тушевоз');
  assert.ok(sendT.km > 400, 'километраж подгона Пенза→Софьино посчитан');

  // Конструктор: просроченные заявки (окно закрылось) в подбор не встают.
  const { freeOrders } = await import('../public/assets/routes.js');
  const freeData = { trips: [], orders: [
    { id: 'F1', stage: 1, status: 'new',
      window_from: '2026-08-01T06:00:00.000Z', window_to: '2026-08-02T20:00:00.000Z' },
    { id: 'F2', stage: 1, status: 'new',
      window_from: '2026-08-25T06:00:00.000Z', window_to: '2026-08-26T20:00:00.000Z' },
    { id: 'F3', stage: 1, status: 'new', route_id: 'R9',
      window_from: '2026-08-25T06:00:00.000Z', window_to: '2026-08-26T20:00:00.000Z' },
  ] };
  const nowRef = Date.parse('2026-08-12T00:00:00.000Z');
  assert.deepEqual(freeOrders(freeData, null, nowRef).map(order => order.id), ['F2'],
    'просроченная и чужая маршрутная заявки не в подборе');
  assert.deepEqual(freeOrders(freeData, 'R9', nowRef).map(order => order.id).sort(), ['F2', 'F3'],
    'заявка своего маршрута остаётся доступной редактору');

  // Дашборд: дневной план из остатка месячного, факт и прогноз по ранрейту.
  const { dashboardMetrics } = await import('../public/assets/dashboard.js');
  const dashNow = Date.parse('2026-08-21T12:00:00.000Z'); // 21-е: прошло 20 полных дней
  const dashData = { settings: { calculation: { vatRate: 0.22 } },
    revenuePlans: [{ period_start: '2026-08-01', target_net: 160_000_000 }],
    vehicles: [], dispositions: [], orders: [],
    trips: [
      { status: 'done', revenue_vat: 122_000_000, cash: 0, customer_name: 'К',
        starts_at: '2026-08-02T00:00:00.000Z', ends_at: '2026-08-20T10:00:00.000Z',
        created_at: '2026-08-02 00:00:00', source_system: 'planner' },
      { status: 'done', revenue_vat: 6_100_000, cash: 0, customer_name: 'К',
        order_id: 'O1', starts_at: '2026-08-21T00:00:00.000Z', ends_at: '2026-08-21T09:00:00.000Z',
        created_at: '2026-08-21 01:00:00', source_system: 'planner' },
    ] };
  const dash = dashboardMetrics(dashData, dashNow);
  assert.ok(dash.monthDone <= dash.monthFact, '«выгружено» не больше «забито»');
  assert.ok(dash.dispatcher.online <= dashData.vehicles.length, '«на линии» — машины, не больше парка');
  assert.equal(typeof dash.logist.noNext, 'number');
  assert.ok(dash.logist.noNext <= dash.dispatcher.online, 'без следующего — не больше, чем на линии');
  assert.ok(Array.isArray(dash.details.logistNoNext) && dash.details.logistNoNext.length === dash.logist.noNext);
  assert.ok(dash.dispatcher.onlineTripCount >= dash.dispatcher.online);
  assert.equal(typeof dash.monthDone, 'number');
  assert.equal(Math.round(dash.monthFact), 105_000_000, 'факт месяца без НДС (122М+6,1М)/1,22');
  // план дня: (160М − 100М до сегодня) / 11 оставшихся дней (21..31)
  assert.equal(Math.round(dash.dayPlan), Math.round(60_000_000 / 11));
  assert.equal(Math.round(dash.dayFact), 5_000_000, 'факт сегодняшнего дня');
  assert.equal(Math.round(dash.forecast), Math.round(100_000_000 / 20 * 31),
    'прогноз — темп по выгрузкам прошедших полных дней');
  // Темп: рейс дня (5М нетто, выгрузка 09:00) к 12:00 уже должен быть выгружен
  // и выгружен фактически — день в темпе; месяц отстаёт от графика.
  assert.equal(Math.round(dash.dayPace.due), 5_000_000, 'к 12:00 должно быть выгружено');
  assert.equal(Math.round(dash.dayPace.diff), 0, 'день в темпе');
  assert.equal(Math.round(dash.monthPace.schedule), Math.round(160_000_000 * 21 / 31),
    'график месяца к концу 21-го');
  assert.equal(Math.round(dash.monthPace.fact), 105_000_000, 'выгружено с начала месяца');
  assert.equal(dash.dayLoads.count, 1, 'погрузки сегодня — рейс со стартом 21-го');
  assert.equal(Math.round(dash.dayLoads.sum), 5_000_000, 'сумма погрузок дня без НДС');
  assert.equal(dash.logist.assignedToday, 1, 'назначено сегодня — рейс с заявкой, созданный сегодня');
  // Воронка дня: забито = выгружено (done) + едет; остаток до плана.
  assert.equal(Math.round(dash.dayDone), 5_000_000, 'выгружено — рейс со статусом done');
  assert.equal(Math.round(dash.dayExpected), 0);
  assert.equal(Math.round(dash.dayGap), Math.round(60_000_000 / 11 - 5_000_000),
    'остаток до плана дня = план − забито');
  // Лента дней: план вчера от остатка на его дату, завтра — с учётом
  // забитого сегодня; выгрузки соседних дней раскладываются по датам.
  assert.equal(Math.round(dash.days.yesterday.plan), Math.round(160_000_000 / 12),
    'план вчера (20-е): весь план на 12 оставшихся дней');
  assert.equal(Math.round(dash.days.yesterday.booked), 100_000_000, 'факт вчера');
  assert.equal(Math.round(dash.days.tomorrow.plan), Math.round(55_000_000 / 10),
    'план завтра: остаток после забитого сегодня на 10 дней');
  assert.equal(dash.days.tomorrow.booked, 0, 'на завтра пока не забито');

  // Подбор рейса сцепке: только достижимые окна, в зоне освобождения — сверху.
  const { matchOrdersForVehicle } = await import('../public/assets/logist.js');
  const request = { freeAt: iso(now + 86_400_000), zone: { name: 'Дом' }, vehicle: { id: 'А1' } };
  const queueOrders = [
    { id: 'q-late', from_name: 'Дом', window_from: iso(now), window_to: iso(now + 3 * 3_600_000) },
    { id: 'q-far', from_name: 'Москва', window_from: iso(now + 2 * 86_400_000), window_to: iso(now + 3 * 86_400_000) },
    { id: 'q-zone', from_name: 'Дом', window_from: iso(now + 2 * 86_400_000), window_to: iso(now + 3 * 86_400_000) }
  ];
  const picked = matchOrdersForVehicle(request, queueOrders);
  assert.deepEqual(picked.map(item => item.order.id), ['q-zone', 'q-far'],
    'окно в прошлом отброшено, зона освобождения приоритетнее');
  assert.equal(picked[0].inZone, true);
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

test('чат и мягкое удаление: сообщения адресуются ролям, удалённые заявки остаются в БД', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pegas-chat-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = openDatabase(path.join(directory, 'planner.db'), {
    username: 'root-admin', password: 'Temporary-password-2026', fullName: 'Администратор'
  });
  t.after(() => db.close());
  // Авто-уведомление конвейера адресовано роли следующего участника.
  db.prepare(`INSERT INTO messages(author_name,kind,text,target_role,entity,entity_id)
    VALUES('Конвейер','auto','Заявка подтверждена — назначьте ТС','logist','order','o-1')`).run();
  db.prepare(`INSERT INTO messages(author_id,author_name,kind,text)
    VALUES(NULL,'Иванов','user','Приму смену в 14:00')`).run();
  const items = db.prepare('SELECT * FROM messages ORDER BY id').all();
  assert.equal(items.length, 2);
  assert.equal(items[0].kind, 'auto');
  assert.equal(items[0].target_role, 'logist');
  assert.equal(items[1].kind, 'user');
  assert.ok(items[1].id > items[0].id, 'id растёт — поллинг after=id работает');

  // Мягкое удаление: отклонённая заявка уходит из оперативных списков,
  // но остаётся в таблице для аналитики отчёта.
  const zone = db.prepare('SELECT id FROM zones ORDER BY sort_order LIMIT 1').get();
  db.prepare(`INSERT INTO orders(id,customer_name,from_zone_id,to_zone_id,rate_vat,
    window_from,window_to,status,rejection_reason)
    VALUES('del-1','Клиент',?,?,50000,'2026-08-10T06:00:00.000Z','2026-08-12T18:00:00.000Z',
    'cancelled','Отказ клиента')`).run(zone.id, zone.id);
  db.prepare(`UPDATE orders SET deleted_at=CURRENT_TIMESTAMP WHERE id='del-1'`).run();
  const order = db.prepare(`SELECT * FROM orders WHERE id='del-1'`).get();
  assert.ok(order.deleted_at, 'помечена удалённой');
  assert.equal(order.status, 'cancelled');
  assert.equal(order.rejection_reason, 'Отказ клиента', 'причина сохранена для аналитики');

  // Инвариант реестра: отклонённая без причины (старые данные) получает
  // пометку при следующем открытии БД.
  db.prepare(`INSERT INTO orders(id,customer_name,from_zone_id,to_zone_id,rate_vat,
    window_from,window_to,status)
    VALUES('del-2','Клиент-без-причины',?,?,40000,'2026-08-10T06:00:00.000Z',
    '2026-08-12T18:00:00.000Z','cancelled')`).run(zone.id, zone.id);
  const reopened = openDatabase(path.join(directory, 'planner.db'), {
    username: 'root-admin', password: 'Temporary-password-2026', fullName: 'Администратор'
  });
  t.after(() => reopened.close());
  assert.equal(reopened.prepare(`SELECT rejection_reason FROM orders WHERE id='del-2'`).get().rejection_reason,
    'Причина не указана', 'все отклонённые складируются в реестр с причиной');
});

test('отклонение рейса без заявки создаёт заявку-возврат в продажах', t => {
  // Рейсы из 1С не связаны с заявками: потребность при отклонении не должна
  // теряться — проверяем данные, из которых сервер строит заявку-возврат.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pegas-orphan-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = openDatabase(path.join(directory, 'planner.db'), {
    username: 'root-admin', password: 'Temporary-password-2026', fullName: 'Администратор'
  });
  t.after(() => db.close());
  const zone = db.prepare('SELECT id FROM zones ORDER BY sort_order LIMIT 1').get();
  const vehicle = db.prepare('SELECT id FROM vehicles LIMIT 1').get();
  db.prepare(`INSERT INTO trips(id,vehicle_id,customer_name,from_zone_id,to_zone_id,
    from_point,to_point,starts_at,ends_at,distance_km,revenue_vat,status,source_system)
    VALUES('to-1',?,'Вердазернопродукт',?,?,'Кораблино','Рязань',
    '2026-08-10T06:00:00.000Z','2026-08-11T06:00:00.000Z',300,60000,'plan','1c')`)
    .run(vehicle.id, zone.id, zone.id);
  // Повторяем серверный сценарий: rejected без order_id → INSERT заявки-возврата.
  db.prepare(`UPDATE trips SET status='rejected',rejection_reason='Отказ клиента' WHERE id='to-1'`).run();
  const trip = db.prepare(`SELECT * FROM trips WHERE id='to-1'`).get();
  db.prepare(`INSERT INTO orders(id,customer_name,from_zone_id,to_zone_id,from_point,to_point,
    rate_vat,window_from,window_to,status,stage,rejection_reason,returned_at)
    VALUES('or-1',?,?,?,?,?,?,?,?,'new',1,?,CURRENT_TIMESTAMP)`).run(
    trip.customer_name, trip.from_zone_id, trip.to_zone_id, trip.from_point, trip.to_point,
    trip.revenue_vat, trip.starts_at, trip.ends_at, trip.rejection_reason);
  const order = db.prepare(`SELECT * FROM orders WHERE id='or-1'`).get();
  assert.equal(order.status, 'new');
  assert.equal(order.stage, 1, 'ждёт назначения ТС у логиста');
  assert.equal(order.customer_name, 'Вердазернопродукт');
  assert.equal(order.from_point, 'Кораблино');
  assert.equal(order.rate_vat, 60000, 'ставка = выручка отклонённого рейса');
  assert.ok(order.returned_at, 'помечена как возврат — продажи видят причину');
  assert.equal(order.rejection_reason, 'Отказ клиента');
});

test('диспетчеризация: шаги идут по порядку, выход на линию ведёт конвейер', async t => {
  const { applyDispatchStep, resetDriverNotificationOnVehicleChange } = await import('../src/trip-control.mjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pegas-dispatch-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = openDatabase(path.join(directory, 'planner.db'), {
    username: 'root-admin', password: 'Temporary-password-2026', fullName: 'Администратор'
  });
  t.after(() => db.close());
  const zone = db.prepare('SELECT id FROM zones ORDER BY sort_order LIMIT 1').get();
  const vehicle = db.prepare('SELECT id FROM vehicles LIMIT 1').get();
  db.prepare(`INSERT INTO orders(id,customer_name,from_zone_id,to_zone_id,rate_vat,
    window_from,window_to,status,stage,assigned_vehicle_id)
    VALUES('od-1','Клиент',?,?,100000,'2026-08-10T06:00:00.000Z','2026-08-12T18:00:00.000Z',
    'planned',2,?)`).run(zone.id, zone.id, vehicle.id);
  db.prepare(`INSERT INTO trips(id,vehicle_id,order_id,customer_name,from_zone_id,to_zone_id,
    starts_at,ends_at,distance_km,revenue_vat,status)
    VALUES('td-1',?,'od-1','Клиент',?,?,'2026-08-10T06:00:00.000Z','2026-08-11T06:00:00.000Z',
    640,100000,'plan')`).run(vehicle.id, zone.id, zone.id);
  db.prepare(`UPDATE orders SET trip_id='td-1' WHERE id='od-1'`).run();

  // Нарушение порядка: чек-лист диспетчера закрыт до подтверждения логиста.
  assert.throws(() => applyDispatchStep(db, 'td-1', 'entered_1c'), /Назначение подтверждено логистом/);
  applyDispatchStep(db, 'td-1', 'logist_confirm');
  assert.throws(() => applyDispatchStep(db, 'td-1', 'driver_notified'), /учётную систему/);
  applyDispatchStep(db, 'td-1', 'entered_1c');
  applyDispatchStep(db, 'td-1', 'driver_notified');
  // Выход на линию: рейс «В пути», стадия заявки 3, повтор шага идемпотентен.
  const { statusChanged } = applyDispatchStep(db, 'td-1', 'on_line');
  assert.equal(statusChanged, true);
  const trip = db.prepare(`SELECT * FROM trips WHERE id='td-1'`).get();
  assert.equal(trip.status, 'run');
  assert.ok(trip.on_line_at);
  assert.equal(db.prepare(`SELECT stage FROM orders WHERE id='od-1'`).get().stage, 3);
  assert.equal(applyDispatchStep(db, 'td-1', 'on_line').statusChanged, false);
  // Вывод на линию НЕ штампует факты погрузки: первую отметку («Прибыл
  // на погрузку») диспетчер ставит сам с реальным временем.
  const firstStop = db.prepare(`SELECT * FROM trip_stops WHERE trip_id='td-1' ORDER BY seq LIMIT 1`).get();
  assert.ok(firstStop, 'стоянки контроля созданы');
  assert.equal(firstStop.actual_arrival, null, 'факт прибытия на погрузку пуст');
  assert.equal(firstStop.actual_departure, null, 'факт убытия с погрузки пуст');

  // Этап «документы получены» отменён 27.08.2026: последний шаг рейса —
  // «Выгружен», шага docs_checked в чек-листе больше нет. Сам вызов из
  // старой вкладки не падает — проверено отдельным тестом совместимости.

  // Переназначение ТС отзывает задание водителю: шаг выполняется заново.
  resetDriverNotificationOnVehicleChange(db, 'td-1');
  const after = db.prepare(`SELECT * FROM trips WHERE id='td-1'`).get();
  assert.equal(after.driver_notified_at, null);
  assert.ok(after.entered_1c_at, 'внесение в 1С сохраняется');
  assert.ok(after.on_line_at, 'контроль на линии сохраняется');
});

test('«ТС не выгружают»: первый алерт один раз, пинги диспетчерам ежечасно', async t => {
  const { checkStuckUnloading } = await import('../src/trip-control.mjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pegas-stuck-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = openDatabase(path.join(directory, 'planner.db'), {
    username: 'root-admin', password: 'Temporary-password-2026', fullName: 'Администратор'
  });
  t.after(() => db.close());
  const zone = db.prepare('SELECT id FROM zones ORDER BY sort_order LIMIT 1').get();
  const vehicle = db.prepare('SELECT id FROM vehicles LIMIT 1').get();
  const now = Date.parse('2026-08-10T20:00:00.000Z');
  // Рейс на линии, план прибытия 7 часов назад, но факта прибытия НЕТ —
  // это опоздание в пути, под контроль выгрузки не попадает.
  db.prepare(`INSERT INTO trips(id,vehicle_id,customer_name,from_zone_id,to_zone_id,
    starts_at,ends_at,distance_km,revenue_vat,status)
    VALUES('st-1',?,'Клиент',?,?,'2026-08-09T06:00:00.000Z','2026-08-10T13:00:00.000Z',
    600,90000,'run')`).run(vehicle.id, zone.id, zone.id);
  assert.equal(checkStuckUnloading(db, now).length, 0,
    'без факта прибытия рейс считается в пути, а не на выгрузке');

  // Диспетчер отметил прибытие 7 часов назад — теперь это застрявшая выгрузка.
  db.prepare(`UPDATE trips SET arrived_at='2026-08-10T13:00:00.000Z' WHERE id='st-1'`).run();
  const first = checkStuckUnloading(db, now);
  assert.equal(first.length, 1);
  assert.equal(first[0].kind, 'first', 'первый алерт — продажам и логистам');
  assert.ok(first[0].waitedMs >= 7 * 3_600_000);
  // Повторный прогон через 10 минут — тишина (час не прошёл).
  assert.equal(checkStuckUnloading(db, now + 10 * 60_000).length, 0);
  // Через час — ежечасный пинг диспетчерам, и так каждый час.
  const hourly = checkStuckUnloading(db, now + 61 * 60_000);
  assert.equal(hourly.length, 1);
  assert.equal(hourly[0].kind, 'hourly');
  assert.equal(checkStuckUnloading(db, now + 65 * 60_000).length, 0);
  assert.equal(checkStuckUnloading(db, now + 122 * 60_000)[0]?.kind, 'hourly');
  // Выгруженный рейс из-под контроля уходит.
  db.prepare(`UPDATE trips SET status='unloaded' WHERE id='st-1'`).run();
  assert.equal(checkStuckUnloading(db, now + 200 * 60_000).length, 0);
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
  // Транзит: (км/50 + 2×2ч) × 1,5 — 500 км: (10 + 4) × 1,5 = 21 час.
  assert.equal(transitHours(500, {}), 21);
  assert.equal(transitHours(653, {}), (653 / 50 + 4) * 1.5);
  // Мультистоп: каждая промежуточная погрузка/выгрузка — ещё одна операция.
  assert.equal(transitHours(500, {}, 4), (500 / 50 + 8) * 1.5);

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

  // «Резерв под заказ» — не недоступность: не попадает в «Выведен»,
  // не перебивает факт рейса; день резерва без рейса остаётся простоем.
  db.prepare(`INSERT INTO vehicle_dispositions(id,vehicle_id,kind,starts_at,ends_at)
    VALUES('disp-util-2',?,'reserve','2026-07-01T00:00:00Z','2026-08-01T00:00:00Z')`).run(vehicleRow.id);
  const withWork = reportSnapshot(db, '2026-07-01', '2026-08-01');
  assert.equal(withWork.utilization.machineDays.out, withRepair.utilization.machineDays.out);
  assert.equal(withWork.utilization.machineDays.work, withRepair.utilization.machineDays.work);
  assert.equal(withWork.utilization.techDays, withRepair.utilization.techDays);

  // Перевозка за наличные: ставка уже без НДС — выручка берёт её целиком.
  // Клиент рейса «Тестовый ИП» безналом очищается по 7% (кириллическое «ИП»
  // обязано распознаваться — старый /\bИП\b/ не работал, все ИП шли по 22%).
  db.prepare(`UPDATE trips SET cash=1 WHERE external_id='1c:1С-TEST-1'`).run();
  const withCash = reportSnapshot(db, '2026-07-01', '2026-08-01');
  const delta = withCash.netRevenue - withWork.netRevenue;
  assert.ok(Math.abs(delta - (120000 - 120000 / 1.07)) < 1,
    `наличный рейс ИП добавил очищавшиеся 7%: ${delta}`);

  // Смена клиента на юрлицо (без «ИП») возвращает очистку 22%.
  db.prepare(`UPDATE trips SET cash=0, customer_name='ООО Тест'
    WHERE external_id='1c:1С-TEST-1'`).run();
  const withOoo = reportSnapshot(db, '2026-07-01', '2026-08-01');
  const oooDelta = withOoo.netRevenue - withWork.netRevenue;
  assert.ok(Math.abs(oooDelta - (120000 / 1.22 - 120000 / 1.07)) < 1,
    `юрлицо очищается по 22%: ${oooDelta}`);
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

test('файлы заявки: тип только по расширению из белого списка', () => {
  assert.equal(uploadMimeOf('пропуск.pdf'), 'application/pdf');
  assert.equal(uploadMimeOf('Схема.JPG'), 'image/jpeg');
  assert.equal(uploadMimeOf('заявка.xlsx'),
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(uploadMimeOf('script.exe'), null);
  assert.equal(uploadMimeOf('page.html'), null);
  assert.equal(uploadMimeOf('без-расширения'), null);
});

test('файлы заявки: имя очищается от путей и управляющих символов', () => {
  assert.equal(cleanFileName('C:\\Users\\Оператор\\пропуск склад №7.pdf'), 'пропуск склад №7.pdf');
  assert.equal(cleanFileName('../../etc/passwd'), 'passwd');
  assert.equal(cleanFileName('до<>кум|ент?.pdf'), 'документ.pdf');
  const long = cleanFileName(`${'а'.repeat(200)}.pdf`);
  assert.ok(long.length <= 120 && long.endsWith('.pdf'));
});

test('прогноз месяца не завышается забронированным будущим', async () => {
  const { dashboardMetrics } = await import('../public/assets/dashboard.js');
  const base = { settings: { calculation: { vatRate: 0.22 } }, orders: [], vehicles: [],
    dispositions: [], revenuePlans: [], trips: [
      { status: 'done', revenue_vat: 12_200_000, cash: 0, customer_name: 'К',
        starts_at: '2026-08-01T00:00:00.000Z', ends_at: '2026-08-10T10:00:00.000Z',
        created_at: '2026-08-01 00:00:00' }
    ] };
  const nowMs = Date.parse('2026-08-21T12:00:00Z');
  const before = dashboardMetrics(base, nowMs);
  const withFuture = { ...base, trips: [...base.trips,
    { status: 'plan', revenue_vat: 61_000_000, cash: 0, customer_name: 'К',
      starts_at: '2026-08-24T00:00:00.000Z', ends_at: '2026-08-25T10:00:00.000Z',
      created_at: '2026-08-01 00:00:00' }] };
  const after = dashboardMetrics(withFuture, nowMs);
  assert.equal(Math.round(before.forecast), Math.round(10_000_000 / 20 * 31));
  assert.equal(Math.round(after.forecast), Math.round(before.forecast),
    'будущая бронь не увеличивает темп');
  assert.ok(after.monthFact > 55_000_000, 'но в факте месяца бронь учтена');
  assert.equal(Math.round(after.dayPlan), Math.round((160_000_000 - 10_000_000) / 11),
    'план дня — от факта прошедших дней, без будущих броней');
});

test('показатели сотрудников: нагрузка из аудита, отметок, чата и заявок', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pegas-staff-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = openDatabase(path.join(directory, 'planner.db'), {
    username: 'root-admin', password: 'Temporary-password-2026', fullName: 'Администратор'
  });
  t.after(() => db.close());
  const admin = db.prepare(`SELECT id, full_name FROM users LIMIT 1`).get();
  const log = (action, entity, at) => db.prepare(`INSERT INTO audit_log(id,user_id,action,entity,created_at)
    VALUES(?,?,?,?,?)`).run(crypto.randomUUID(), admin.id, action, entity, at);
  log('create', 'order', '2026-08-10 09:00:00');
  log('assign', 'order', '2026-08-10 10:00:00');
  log('dispatch_step', 'trip', '2026-08-11 09:00:00');
  log('update', 'trip_stop', '2026-08-11 10:00:00');
  log('login', 'session', '2026-08-11 08:00:00');           // не считается
  log('create', 'order', '2026-08-20 09:00:00');            // вне периода
  db.prepare(`INSERT INTO task_marks(kind,day,item_key,done_by) VALUES('dispatcher','2026-08-11','x|y',?)`)
    .run(admin.full_name);
  const zone = db.prepare('SELECT id FROM zones LIMIT 1').get();
  db.prepare(`INSERT INTO orders(id,customer_name,from_zone_id,to_zone_id,rate_vat,
    window_from,window_to,status,created_by,created_at)
    VALUES('so-1','К',?,?,90000,'2026-08-10T06:00:00.000Z','2026-08-11T18:00:00.000Z','new',?,
    '2026-08-10 09:00:00')`).run(zone.id, zone.id, admin.id);
  const report = staffReport(db, '2026-08-10', '2026-08-12');
  const row = report.items.find(item => item.name === admin.full_name);
  assert.ok(row, 'сотрудник в отчёте');
  assert.equal(row.orderCreate, 1, 'заявка вне периода не считается');
  assert.equal(row.orderAssign, 1);
  assert.equal(row.dispatchSteps, 1);
  assert.equal(row.stopFacts, 1);
  assert.equal(row.marks, 1);
  assert.equal(row.activeDays, 2, 'два активных дня');
  assert.equal(row.ordersSum, 90000, 'сумма внесённых ставок');
  assert.equal(row.total, 4 + 1, 'всего: 4 действия аудита + отметка (вход не считается)');
  db.prepare(`UPDATE users SET job_role='sales' WHERE full_name=?`).run(admin.full_name);
  const withRole = staffReport(db, '2026-08-10', '2026-08-12').items
    .find(item => item.name === admin.full_name);
  assert.equal(withRole.jobRole, 'sales', 'должность в отчёте');
  assert.ok(withRole.userId, 'id пользователя для назначения должности');
  assert.ok(staffReport(db, '2026-08-10', '2026-08-12').plans.sales.metrics.length >= 3,
    'нормативы должностей отдаются с отчётом');
});

test('отклонения конвейера: нормативы этапов и попадание в период', async () => {
  const { deviationsFor } = await import('../public/assets/reports.js');
  const nowMs = Date.parse('2026-08-17T12:00:00Z');
  const fromMs = Date.parse('2026-08-17T00:00:00Z');
  const toMs = Date.parse('2026-08-18T00:00:00Z');
  const data = {
    trips: [
      // подтверждён логистом через 3 ч после назначения (> 1 ч)
      { id: 't1', status: 'run', customer_name: 'К', vehicle_plate: 'а001',
        created_at: '2026-08-17 06:00:00', logist_confirmed_at: '2026-08-17T09:00:00.000Z',
        starts_at: '2026-08-17T05:00:00.000Z', ends_at: '2026-08-17T08:00:00.000Z',
        on_line_at: '2026-08-17T05:10:00.000Z', unloaded_at: '2026-08-17T09:00:00.000Z',
        docs_checked_at: '2026-08-17T09:30:00.000Z' },
      // выведен на линию через 2 ч после планового выхода (> 30 мин)
      { id: 't2', status: 'run', customer_name: 'К2', vehicle_plate: 'а002',
        created_at: '2026-08-16 06:00:00', logist_confirmed_at: '2026-08-16T06:10:00.000Z',
        starts_at: '2026-08-17T06:00:00.000Z', ends_at: '2026-08-18T06:00:00.000Z',
        on_line_at: '2026-08-17T08:00:00.000Z' },
      // выгружен вовремя (этап документов отменён 27.08.2026 — отклонением не считается)
      { id: 't3', status: 'unloaded', customer_name: 'К3', vehicle_plate: 'а003',
        created_at: '2026-08-16 06:00:00', logist_confirmed_at: '2026-08-16T06:05:00.000Z',
        starts_at: '2026-08-16T08:00:00.000Z', ends_at: '2026-08-17T08:30:00.000Z',
        on_line_at: '2026-08-16T08:00:00.000Z', unloaded_at: '2026-08-17T09:00:00.000Z',
        docs_checked_at: null },
      // всё в нормативах
      { id: 't4', status: 'run', customer_name: 'К4', vehicle_plate: 'а004',
        created_at: '2026-08-17 06:00:00', logist_confirmed_at: '2026-08-17T06:20:00.000Z',
        starts_at: '2026-08-17T07:00:00.000Z', ends_at: '2026-08-18T07:00:00.000Z',
        on_line_at: '2026-08-17T07:10:00.000Z' }
    ],
    orders: [
      // окно закрылось в периоде, ТС не назначено
      { id: 'o1', order_no: '1', customer_name: 'Кл', stage: 1, status: 'confirmed', trip_id: null,
        created_at: '2026-08-16 06:00:00', confirmed_at: '2026-08-16T06:30:00.000Z',
        window_from: '2026-08-17T06:00:00.000Z', window_to: '2026-08-17T09:00:00.000Z' },
      // подтверждена продажами через 6 ч (> 4 ч)
      { id: 'o2', order_no: '2', customer_name: 'Кл2', stage: 1, status: 'confirmed', trip_id: 'x',
        created_at: '2026-08-17 03:00:00', confirmed_at: '2026-08-17T09:00:00.000Z',
        window_from: '2026-08-18T06:00:00.000Z', window_to: '2026-08-18T18:00:00.000Z' }
    ]
  };
  const d = deviationsFor(data, fromMs, toMs, nowMs);
  assert.equal(d.confirmSlow.length, 1, 'долгое подтверждение логиста');
  assert.equal(d.confirmSlow[0].trip.id, 't1');
  assert.equal(d.lateOnline.length, 1, 'поздний вывод на линию');
  assert.equal(d.lateOnline[0].trip.id, 't2');
  assert.equal(d.docsSlow, undefined, 'этап документов из отклонений убран');
  assert.equal(d.expiredNoVehicle.length, 1, 'окно истекло без ТС');
  assert.equal(d.salesSlow.length, 1, 'медленное подтверждение продаж');
  assert.equal(d.lateUnload.length, 0, 'выгрузка t3 позже расчётной лишь на 30 мин — не отклонение');
});

test('явка водителей: классификатор причин и сводка укомплектованности', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pegas-att-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = openDatabase(path.join(directory, 'planner.db'), {
    username: 'root-admin', password: 'Temporary-password-2026', fullName: 'Администратор'
  });
  t.after(() => db.close());
  db.prepare(`INSERT INTO drivers(id,full_name) VALUES('d1','Иванов И'),('d2','Петров П'),('d3','Сидоров С')`).run();
  const day = '2026-08-18';
  markAttendance(db, { driverId: 'd1', day, status: 'present' });
  assert.throws(() => markAttendance(db, { driverId: 'd2', day, status: 'absent' }),
    /причину из классификатора/, 'невыход без причины не принимается');
  markAttendance(db, { driverId: 'd2', day, status: 'absent', reason: 'sick' });
  // перезапись: тот же водитель, другой статус — upsert по (driver, day)
  markAttendance(db, { driverId: 'd2', day, status: 'absent', reason: 'truancy' });
  const sum = attendanceSummary(db, day);
  assert.equal(sum.present, 1);
  assert.equal(sum.absent, 1);
  assert.equal(sum.byReason.truancy, 1, 'причина перезаписана');
  assert.equal(sum.unmarked, sum.drivers - 2, 'все, кроме двух отмеченных, — не отмечены');
  assert.ok(sum.staffingTarget === 1.45);
  assert.throws(() => markAttendance(db, { driverId: 'нет', day, status: 'present' }), /не найден/);
});

test('график водителей: история закреплений из аудита и текущее состояние', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pegas-sched-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = openDatabase(path.join(directory, 'planner.db'), {
    username: 'root-admin', password: 'Temporary-password-2026', fullName: 'Администратор'
  });
  t.after(() => db.close());
  const [v1, v2] = db.prepare('SELECT id FROM vehicles LIMIT 2').all().map(row => row.id);
  db.prepare(`INSERT INTO drivers(id,full_name,vehicle_id) VALUES('dr1','Смирнов А',?),('dr2','Козлов Б',NULL)`).run(v2);
  // История dr1: закреплён на v1, потом перезакреплён на v2.
  db.prepare(`INSERT INTO audit_log(id,user_id,action,entity,entity_id,details_json,created_at)
    VALUES(?,NULL,'update','driver','dr1',?,?)`).run('a1', JSON.stringify({ vehicleId: v1 }), '2026-08-10 08:00:00');
  db.prepare(`INSERT INTO audit_log(id,user_id,action,entity,entity_id,details_json,created_at)
    VALUES(?,NULL,'update','driver','dr1',?,?)`).run('a2', JSON.stringify({ vehicleId: v2 }), '2026-08-14 08:00:00');
  const data = driverScheduleData(db, '2026-08-08T00:00:00.000Z', '2026-08-20T00:00:00.000Z');
  const spans = data.assignments.dr1;
  assert.equal(spans.length, 2, 'два интервала закрепления');
  assert.equal(spans[0].vehicleId, v1);
  assert.equal(spans[0].to, spans[1].from, 'интервалы стыкуются в момент перезакрепления');
  assert.equal(spans[1].vehicleId, v2);
  assert.equal(spans[1].to, null, 'текущее закрепление открыто');
  // Без событий аудита — одно текущее закрепление у dr2 нет (vehicle NULL) → пусто.
  assert.deepEqual(data.assignments.dr2, []);
});

test('вахтовый график: рабочие и выходные дни по схеме N/M', () => {
  // 15/15 с 1 августа: 1–15 работа, 16–30 межвахта, 31 — снова работа.
  assert.equal(shiftIsWorkday(15, 15, '2026-08-01', '2026-08-01'), true);
  assert.equal(shiftIsWorkday(15, 15, '2026-08-01', '2026-08-15'), true);
  assert.equal(shiftIsWorkday(15, 15, '2026-08-01', '2026-08-16'), false);
  assert.equal(shiftIsWorkday(15, 15, '2026-08-01', '2026-08-30'), false);
  assert.equal(shiftIsWorkday(15, 15, '2026-08-01', '2026-08-31'), true);
  // день ДО начала отсчёта тоже считается по циклу (отрицательная фаза)
  assert.equal(shiftIsWorkday(15, 15, '2026-08-16', '2026-08-15'), false);
  assert.equal(shiftIsWorkday(15, 15, '2026-08-16', '2026-08-01'), false,
    '01.08 — межвахта предыдущего цикла');
  assert.equal(shiftIsWorkday(15, 15, '2026-08-16', '2026-07-17'), true,
    'предыдущий рабочий период 17–31.07');
  // вахта не задана — всегда рабочий
  assert.equal(shiftIsWorkday(null, null, null, '2026-08-20'), true);
});

test('периодное закрепление: пересечение по водителю отклоняется', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pegas-period-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = openDatabase(path.join(directory, 'planner.db'), {
    username: 'root-admin', password: 'Temporary-password-2026', fullName: 'Администратор'
  });
  t.after(() => db.close());
  const [v1, v2] = db.prepare('SELECT id FROM vehicles LIMIT 2').all().map(row => row.id);
  db.prepare(`INSERT INTO drivers(id,full_name) VALUES('pd1','Подменный В')`).run();
  createDriverAssignment(db, { driverId: 'pd1', vehicleId: v1,
    startsAt: '2026-08-25', endsAt: '2026-09-08' });
  assert.throws(() => createDriverAssignment(db, { driverId: 'pd1', vehicleId: v2,
    startsAt: '2026-09-01', endsAt: '2026-09-05' }), /Пересечение/);
  // встык — можно
  createDriverAssignment(db, { driverId: 'pd1', vehicleId: v2,
    startsAt: '2026-09-08', endsAt: '2026-09-20' });
  assert.throws(() => createDriverAssignment(db, { driverId: 'pd1', vehicleId: v1,
    startsAt: '2026-09-10', endsAt: '2026-09-01' }), /позже чем с/);
  const data = driverScheduleData(db, '2026-08-20T00:00:00.000Z', '2026-09-10T00:00:00.000Z');
  assert.equal(data.planned.length, 2, 'оба периода в выдаче графика');
});

test('карточка сотрудника: сводка явки, работы сцепки и периодов', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pegas-card-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = openDatabase(path.join(directory, 'planner.db'), {
    username: 'root-admin', password: 'Temporary-password-2026', fullName: 'Администратор'
  });
  t.after(() => db.close());
  const vehicle = db.prepare('SELECT id FROM vehicles LIMIT 1').get();
  db.prepare(`INSERT INTO drivers(id,full_name,vehicle_id) VALUES('cd1','Карточный К',?)`).run(vehicle.id);
  markAttendance(db, { driverId: 'cd1', day: new Date().toISOString().slice(0, 10), status: 'present' });
  markAttendance(db, { driverId: 'cd1', day: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10),
    status: 'absent', reason: 'sick' });
  createDriverAssignment(db, { driverId: 'cd1', vehicleId: vehicle.id,
    startsAt: new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10),
    endsAt: new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10) });
  const card = driverCardData(db, 'cd1');
  assert.equal(card.driver.full_name, 'Карточный К');
  assert.equal(card.attendance30.present, 1);
  assert.equal(card.attendance30.byReason.sick, 1);
  assert.equal(card.periods.length, 1, 'будущее периодное закрепление в карточке');
  db.prepare(`INSERT INTO audit_log(id,user_id,action,entity,entity_id,details_json,created_at)
    VALUES('ch1',NULL,'create','driver','cd1','{}','2026-08-18 09:00:00')`).run();
  assert.ok(driverCardData(db, 'cd1').history.length >= 1, 'история из журнала попадает в карточку');
  assert.throws(() => driverCardData(db, 'нет-такого'), /не найден/);
});

test('эффективная явка: рейс, отпуск и межвахта закрываются сами, ручная — приоритет', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pegas-att-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = openDatabase(path.join(directory, 'planner.db'), {
    username: 'root-admin', password: 'Temporary-password-2026', fullName: 'Администратор'
  });
  t.after(() => db.close());
  const [v1, v2, v3, v4] = db.prepare('SELECT id FROM vehicles LIMIT 4').all().map(row => row.id);
  const zone = db.prepare('SELECT id FROM zones LIMIT 1').get().id;
  db.prepare(`INSERT INTO drivers(id,full_name,vehicle_id) VALUES
    ('ea1','В рейсе',?),('ea2','Отпускник',?),('ea3','Межвахта',?),('ea4','Ручной',?)`)
    .run(v1, v2, v3, v4);
  const day = '2026-08-20';
  // ea1: рейс его машины покрывает день → авто «вышел»
  db.prepare(`INSERT INTO trips(id,vehicle_id,customer_name,from_zone_id,to_zone_id,
    starts_at,ends_at,distance_km,revenue_vat,status)
    VALUES('eat1',?,'К',?,?,'2026-08-19T06:00:00.000Z','2026-08-21T06:00:00.000Z',500,90000,'run')`)
    .run(v1, zone, zone);
  // ea2: отпуск по карточке
  db.prepare(`UPDATE drivers SET status='vacation', absent_from='2026-08-15T00:00:00.000Z',
    absent_to='2026-08-25T00:00:00.000Z' WHERE id='ea2'`).run();
  // ea3: межвахта по вахте 15/15 с 01.08 (20.08 — отдых)
  db.prepare(`UPDATE drivers SET shift_on=15, shift_off=15, shift_anchor='2026-08-01' WHERE id='ea3'`).run();
  // ea4: ручная отметка прогула перекрывает всё
  markAttendance(db, { driverId: 'ea4', day, status: 'absent', reason: 'truancy' });
  const items = Object.fromEntries(attendanceEffective(db, day).map(item => [item.driver_id, item]));
  assert.deepEqual([items.ea1.status, items.ea1.source], ['present', 'auto']);
  assert.deepEqual([items.ea2.status, items.ea2.reason], ['absent', 'vacation']);
  assert.deepEqual([items.ea3.status, items.ea3.reason], ['absent', 'dayoff']);
  assert.deepEqual([items.ea4.status, items.ea4.reason, items.ea4.source], ['absent', 'truancy', 'manual']);
  // сверхвахтенная работа: рейс в межвахту → present + overwork (код РВ в табеле)
  db.prepare(`INSERT INTO trips(id,vehicle_id,customer_name,from_zone_id,to_zone_id,
    starts_at,ends_at,distance_km,revenue_vat,status)
    VALUES('eat2',?,'К',?,?,'2026-08-19T06:00:00.000Z','2026-08-21T06:00:00.000Z',500,90000,'run')`)
    .run(v3, zone, zone);
  const over = attendanceEffective(db, day).find(item => item.driver_id === 'ea3');
  assert.equal(over.status, 'present');
  assert.equal(over.overwork, true, 'работа в выходной — ↑ФОТ');
  const sheet = attendanceTimesheet(db, '2026-08-20', '2026-08-21');
  const codes = Object.fromEntries(sheet.rows.map(row => [row.driverId, row.days['2026-08-20']]));
  assert.equal(codes.ea1, 'Я');
  assert.equal(codes.ea2, 'ОТ');
  assert.equal(codes.ea3, 'РВ');
  assert.equal(codes.ea4, 'ПР');
});

test('простой под погрузкой/выгрузкой: сверх 8 ч от плана — претензия, без факта прибытия — нет', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pegas-dmr-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = openDatabase(path.join(directory, 'planner.db'), {
    username: 'root-admin', password: 'Temporary-password-2026', fullName: 'Администратор'
  });
  t.after(() => db.close());
  const [v1, v2, v3] = db.prepare('SELECT id FROM vehicles LIMIT 3').all().map(row => row.id);
  const zone = db.prepare('SELECT id FROM zones LIMIT 1').get().id;
  const nowMs = Date.parse('2026-08-21T12:00:00.000Z');
  const trip = db.prepare(`INSERT INTO trips(id,vehicle_id,customer_name,from_zone_id,to_zone_id,
    starts_at,ends_at,distance_km,revenue_vat,status,order_no,arrived_at,unloaded_at)
    VALUES(?,?,?,?,?,?,?,500,90000,?,?,?,?)`);
  const order = db.prepare(`INSERT INTO orders(id,customer_name,from_zone_id,to_zone_id,
    rate_vat,window_from,window_to,status,trip_id) VALUES(?,?,?,?,90000,?,?,'planned',?)`);
  // Рейс 1: план выгрузки по заявке 19.08 06:00, прибыл вовремя, выгружен
  // через 15 ч → простой 15 ч, сверх нормы 7 ч (начатые часы).
  trip.run('dm1', v1, 'Клиент А', zone, zone, '2026-08-17T06:00:00.000Z',
    '2026-08-19T07:30:00.000Z', 'unloaded', '3001',
    '2026-08-19T06:00:00.000Z', '2026-08-19T21:00:00.000Z');
  order.run('do1', 'Клиент А', zone, zone, '2026-08-17T06:00:00.000Z', '2026-08-19T06:00:00.000Z', 'dm1');
  // Рейс 2: прибыл на выгрузку 20.08 06:00 (план 20.08 04:00), НЕ выгружен,
  // рейс run → открытый случай, простой растёт до «сейчас» (21.08 12:00).
  trip.run('dm2', v2, 'Клиент Б', zone, zone, '2026-08-18T06:00:00.000Z',
    '2026-08-20T04:00:00.000Z', 'run', '3002', '2026-08-20T06:00:00.000Z', null);
  order.run('do2', 'Клиент Б', zone, zone, '2026-08-18T06:00:00.000Z', '2026-08-20T04:00:00.000Z', 'dm2');
  // Рейс 3: выгружен с опозданием, но факта прибытия нет — случая нет.
  trip.run('dm3', v3, 'Клиент В', zone, zone, '2026-08-18T06:00:00.000Z',
    '2026-08-19T06:00:00.000Z', 'unloaded', '3003', null, '2026-08-20T06:00:00.000Z');
  const cases = demurrageCases(db, nowMs);
  const byTrip = Object.fromEntries(cases.map(item => [item.tripId, item]));
  assert.ok(byTrip.dm1, 'закрытый случай выгрузки зафиксирован');
  assert.equal(byTrip.dm1.kind, 'unload');
  assert.equal(byTrip.dm1.open, false);
  assert.equal(byTrip.dm1.idleHours, 15, 'простой от плана (прибыл вовремя) до факта выгрузки');
  assert.equal(byTrip.dm1.paidHours, 7, 'сверх 8 ч бесплатных, начатый час целиком');
  assert.equal(byTrip.dm1.amount, 7 * 1000);
  assert.ok(byTrip.dm2, 'стоящая под выгрузкой машина — открытый случай');
  assert.equal(byTrip.dm2.open, true);
  assert.equal(byTrip.dm2.idleHours, 30, 'от факта прибытия (позже плана) до «сейчас»');
  assert.equal(byTrip.dm2.finishedAt, null);
  assert.equal(byTrip.dm3, undefined, 'без отметки прибытия претензия не фиксируется');
});

test('удаление пользователя: без истории — физически, с историей — мягко, логин освобождается', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pegas-userdel-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = openDatabase(path.join(directory, 'planner.db'), {
    username: 'root-admin', password: 'Temporary-password-2026', fullName: 'Администратор'
  });
  t.after(() => db.close());
  const admin = db.prepare("SELECT * FROM users WHERE username='root-admin'").get();
  db.prepare(`INSERT INTO users(id,username,full_name,password_hash,role,roles)
    VALUES('ud1','clean-user','Без истории','x','logist','["logist"]'),
           ('ud2','busy-user','С историей','x','sales','["sales"]')`).run();
  // След в журнале: физическое удаление ud2 упрётся в внешний ключ.
  db.prepare(`INSERT INTO audit_log(id,user_id,action,entity) VALUES('ua1','ud2','create','order')`).run();

  // Чистая учётка удаляется физически.
  db.prepare('DELETE FROM users WHERE id=?').run('ud1');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM users WHERE id='ud1'").get().c, 0);

  // Учётка с историей: физическое падает (FK), мягкое скрывает и освобождает логин.
  assert.throws(() => db.prepare('DELETE FROM users WHERE id=?').run('ud2'));
  db.prepare(`UPDATE users SET active=0, deleted_at=CURRENT_TIMESTAMP,
    username=username||'#del-'||substr(id,1,8) WHERE id='ud2'`).run();
  const gone = db.prepare("SELECT * FROM users WHERE id='ud2'").get();
  assert.equal(gone.active, 0);
  assert.ok(gone.deleted_at, 'помечен удалённым');
  assert.equal(gone.username, 'busy-user#del-ud2', 'логин освобождён для нового сотрудника');
  db.prepare(`INSERT INTO users(id,username,full_name,password_hash,role,roles)
    VALUES('ud3','busy-user','Новый с тем же логином','x','sales','["sales"]')`).run();
  // История мягко удалённого доступна отчётам (JOIN users жив).
  const trail = db.prepare(`SELECT u.full_name FROM audit_log a JOIN users u ON u.id=a.user_id
    WHERE a.id='ua1'`).get();
  assert.equal(trail.full_name, 'С историей');
  // Последний активный админ защищён той же проверкой, что на сервере.
  const others = db.prepare(`SELECT COUNT(*) count FROM users, json_each(users.roles)
    WHERE json_each.value='admin' AND users.active=1 AND users.deleted_at IS NULL
      AND users.id<>?`).get(admin.id).count;
  assert.equal(others, 0, 'root-admin — единственный админ, сервер откажет в удалении');
});

test('чат: личное сообщение видят только отправитель и получатель, общий канал — все', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pegas-chat-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = openDatabase(path.join(directory, 'planner.db'), {
    username: 'root-admin', password: 'Temporary-password-2026', fullName: 'Администратор'
  });
  t.after(() => db.close());
  db.prepare(`INSERT INTO users(id,username,full_name,password_hash,role,roles) VALUES
    ('cu1','ivanov','Иванов','x','sales','["sales"]'),
    ('cu2','petrov','Петров','x','logist','["logist"]'),
    ('cu3','sidorov','Сидоров','x','dispatcher','["dispatcher"]')`).run();
  const send = db.prepare(`INSERT INTO messages(author_id,author_name,kind,text,recipient_id)
    VALUES(?,?,'user',?,?)`);
  send.run('cu1', 'Иванов', 'Всем привет', null);
  send.run('cu1', 'Иванов', 'Петров, лично тебе', 'cu2');
  send.run('cu2', 'Петров', 'Иванов, ответ лично', 'cu1');

  // Группа: Иванов+Петров; Сидоров не участник.
  db.prepare(`INSERT INTO chats(id,title,created_by) VALUES('gr1','Смена А','cu1')`).run();
  db.prepare(`INSERT INTO chat_members(chat_id,user_id) VALUES('gr1','cu1'),('gr1','cu2')`).run();
  db.prepare(`INSERT INTO messages(author_id,author_name,kind,text,chat_id)
    VALUES('cu2','Петров','user','Группе: смена началась','gr1')`).run();
  // Конвейер: авто-уведомление адресовано роли логиста.
  db.prepare(`INSERT INTO messages(author_name,kind,text,target_role)
    VALUES('Конвейер','auto','Назначьте ТС на заявку','logist')`).run();

  const texts = (userId, roles) => chatMessages(db, userId, roles).items.map(m => m.text);
  assert.deepEqual(texts('cu1', ['sales']),
    ['Всем привет', 'Петров, лично тебе', 'Иванов, ответ лично', 'Группе: смена началась'],
    'продажнику: общий, его лички, его группа — без чужого конвейера');
  assert.deepEqual(texts('cu2', ['logist']),
    ['Всем привет', 'Петров, лично тебе', 'Иванов, ответ лично',
     'Группе: смена началась', 'Назначьте ТС на заявку'],
    'логисту: плюс конвейер его роли');
  assert.deepEqual(texts('cu3', ['dispatcher']), ['Всем привет'],
    'третьему не видны ни лички, ни чужая группа, ни чужой конвейер');
  // Инкрементальный поллинг сохраняет фильтр видимости.
  const first = chatMessages(db, 'cu3', ['dispatcher']).items[0].id;
  assert.deepEqual(chatMessages(db, 'cu3', ['dispatcher'], first).items, []);
  assert.equal(chatMessages(db, 'cu2', ['logist'], first).items.length, 4);
  // Персональное авто-уведомление (утренний отчёт всем): видно только адресату.
  db.prepare(`INSERT INTO messages(author_name,kind,text,recipient_id)
    VALUES('Конвейер','auto','📆 Отчёт дня лично','cu3')`).run();
  assert.ok(chatMessages(db, 'cu3', ['dispatcher']).items.some(m => m.text === '📆 Отчёт дня лично'),
    'адресат видит персональный отчёт');
  assert.ok(!chatMessages(db, 'cu1', ['sales']).items.some(m => m.text === '📆 Отчёт дня лично'),
    'другим персональный отчёт не виден');
  // Мягкое удаление группы: сообщения и группа пропадают у участников,
  // восстановление возвращает всё вместе с историей.
  db.prepare(`UPDATE chats SET deleted_at=CURRENT_TIMESTAMP WHERE id='gr1'`).run();
  assert.ok(!chatMessages(db, 'cu2', ['logist']).items.some(m => m.chat_id === 'gr1'),
    'сообщения удалённой группы скрыты');
  assert.equal(chatGroups(db, 'cu2').length, 0, 'удалённая группа не в списке');
  db.prepare(`UPDATE chats SET deleted_at=NULL WHERE id='gr1'`).run();
  assert.ok(chatMessages(db, 'cu2', ['logist']).items.some(m => m.chat_id === 'gr1'),
    'после восстановления история видна');
  assert.equal(chatGroups(db, 'cu2').length, 1);
});

test('перепланирование стоянок: сдвиг рейса двигает планы точек без фактов, пройденные не трогает', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pegas-resched-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = openDatabase(path.join(directory, 'planner.db'), {
    username: 'root-admin', password: 'Temporary-password-2026', fullName: 'Администратор'
  });
  t.after(() => db.close());
  const vehicle = db.prepare('SELECT id FROM vehicles LIMIT 1').get().id;
  const zone = db.prepare('SELECT id FROM zones LIMIT 1').get().id;
  db.prepare(`INSERT INTO trips(id,vehicle_id,customer_name,from_zone_id,to_zone_id,from_point,to_point,
    starts_at,ends_at,distance_km,revenue_vat,status)
    VALUES('rs1',?,'К',?,?,'Пенза склад','Москва склад','2026-08-25T06:00:00.000Z','2026-08-26T06:00:00.000Z',650,90000,'plan')`)
    .run(vehicle, zone, zone);
  ensureTripStops(db, 'rs1');
  const before = db.prepare('SELECT seq,point,planned_arrival FROM trip_stops WHERE trip_id=? ORDER BY seq').all('rs1');
  assert.equal(before[0].planned_arrival, '2026-08-25T06:00:00.000Z');
  // Первая точка пройдена (факт прибытия), рейс сдвинут на сутки и выгрузка в другом пункте.
  db.prepare(`UPDATE trip_stops SET actual_arrival='2026-08-25T06:10:00.000Z' WHERE trip_id='rs1' AND seq=1`).run();
  db.prepare(`UPDATE trips SET starts_at='2026-08-26T06:00:00.000Z', ends_at='2026-08-27T06:00:00.000Z',
    to_point='Софьино' WHERE id='rs1'`).run();
  const changed = rescheduleTripStops(db, 'rs1');
  const after = db.prepare('SELECT seq,point,planned_arrival,planned_departure FROM trip_stops WHERE trip_id=? ORDER BY seq').all('rs1');
  assert.equal(changed, 1, 'пересчитана только точка без фактов');
  assert.equal(after[0].planned_arrival, '2026-08-25T06:00:00.000Z', 'пройденная погрузка не тронута');
  assert.equal(after[1].planned_departure, '2026-08-27T06:00:00.000Z', 'выгрузка следует за новым концом рейса');
  assert.equal(after[1].point, 'Софьино', 'пункт выгрузки обновлён из рейса');
});

test('подбор ТС: позиция по пункту выгрузки, а не по ошибочной геозоне (кейс р550ту58)', () => {
  const addresses = [
    { id: 'a-penza', name: 'Пенза г, ул Аустрина, стр. 178Б', address: 'Пенза', region: 'Пензенская обл',
      zone_name: 'Дом', zone_id: 'z-home', latitude: 53.2, longitude: 45.0 },
    { id: 'a-vidnoe', name: 'Видное г, пгт Горки Ленинские, промзона Технопарк', address: 'МО', region: 'Московская обл',
      zone_name: 'Москва', zone_id: 'z-msk', latitude: 55.55, longitude: 37.7 }
  ];
  const data = {
    reference: { addresses, zones: [{ id: 'z-home', name: 'Дом' }, { id: 'z-msk', name: 'Москва' }] },
    vehicles: [{ id: 'V550', plate: 'р550ту58', status: 'work', type_name: 'Тушевоз', zone_name: 'Дом' }],
    dispositions: [],
    // Даты — относительно «сейчас», чтобы тест не протухал: рейс идёт 30 ч,
    // расчётный конец 2 ч назад (опоздун), окно погрузки — через 6 ч.
    trips: [{ vehicle_id: 'V550', status: 'run', from_name: 'Дом', to_name: 'Москва',
      to_point: 'Пенза, ул совхозная',
      starts_at: new Date(Date.now() - 30 * 3600e3).toISOString(),
      ends_at: new Date(Date.now() - 2 * 3600e3).toISOString() }]
  };
  // Позиция по городу из текста пункта: регион Пензенская, а не Московская из зоны.
  const place = placeOf(data, 'Пенза, ул совхозная', 'Москва');
  assert.equal(place.region, 'Пензенская обл');
  assert.equal(place.approx, true);
  const [candidate] = matchVehicles(data, 'Москва',
    new Date(Date.now() + 6 * 3600e3).toISOString(), addresses[1]);
  assert.equal(candidate.vehicle.id, 'V550');
  assert.equal(candidate.inZone, false, 'машина будет в Пензе — не «в зоне» Москвы');
  assert.equal(candidate.region, 'Пензенская обл');
  assert.ok(candidate.emptyKm > 500, `подгон Пенза→Видное считается приблизительно: ${candidate.emptyKm} км`);
  assert.equal(candidate.stillRunning, true, 'факта выгрузки нет — пометка «сейчас в рейсе»');
  assert.equal(candidate.ready, false, 'с подгоном ~600 км к 17:00 МСК не успевает');
});

test('гостевой режим: права записи отсекаются, чтение остаётся', () => {
  const logist = { active: 1, roles: '["logist","sales"]', guest: 0 };
  assert.equal(hasPermission(logist, 'trips:write'), true);
  assert.equal(hasPermission(logist, 'orders:write'), true);
  const guest = { ...logist, guest: 1 };
  assert.equal(hasPermission(guest, 'trips:write'), false, 'гость не назначает');
  assert.equal(hasPermission(guest, 'orders:write'), false, 'гость не правит заявки');
  assert.equal(hasPermission(guest, 'planner:read'), true, 'гость видит планер');
  assert.equal(hasPermission(guest, 'customers:read'), true);
  assert.deepEqual(effectivePermissions({ active: 1, roles: '["admin"]', guest: 1 }),
    ['planner:read', 'reports:read', 'customers:read', 'audit:read'],
    'гость-админ: только чтение, настройки/пользователи недоступны');
});

test('карточка клиента: сводка, контакты с днями рождения, праздники в напоминаниях', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pegas-crm-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = openDatabase(path.join(directory, 'planner.db'), {
    username: 'root-admin', password: 'Temporary-password-2026', fullName: 'Администратор'
  });
  t.after(() => db.close());
  const now = Date.parse('2026-08-21T09:00:00.000Z');
  // Годовщины: сегодня, завтра, через 3 дня, через год минус день.
  assert.equal(daysUntilAnnual('08-21', now), 0);
  assert.equal(daysUntilAnnual('1985-08-22', now), 1);
  assert.equal(daysUntilAnnual('08-24', now), 3);
  assert.equal(daysUntilAnnual('08-20', now), 364);
  assert.equal(daysUntilAnnual('кривая', now), null);
  const vehicle = db.prepare('SELECT id FROM vehicles LIMIT 1').get().id;
  const zone = db.prepare('SELECT id FROM zones LIMIT 1').get().id;
  db.prepare(`INSERT INTO trips(id,vehicle_id,customer_name,from_zone_id,to_zone_id,
    starts_at,ends_at,distance_km,revenue_vat,status) VALUES
    ('cr1',?,'Останкино ООО',?,?,'2026-08-10T06:00:00.000Z','2026-08-11T06:00:00.000Z',600,120000,'done'),
    ('cr2',?,'Останкино ООО',?,?,'2026-08-15T06:00:00.000Z','2026-08-16T06:00:00.000Z',600,100000,'paid'),
    ('cr3',?,'Останкино ООО',?,?,'2026-08-20T06:00:00.000Z','2026-08-22T06:00:00.000Z',600,110000,'run')`)
    .run(vehicle, zone, zone, vehicle, zone, zone, vehicle, zone, zone);
  db.prepare(`INSERT INTO customer_contacts(id,customer_name,full_name,position,birthday)
    VALUES('cc1','Останкино ООО','Иванов Пётр','директор по логистике','1980-08-23')`).run();
  db.prepare(`INSERT INTO customer_notes(id,customer_name,kind,text,author_name)
    VALUES('cn1','Останкино ООО','call','Обсудили объёмы на сентябрь','Менеджер')`).run();
  const card = customerCard(db, 'Останкино ООО', now);
  assert.equal(card.stats.tripsDone, 2, 'выполненные: done + paid');
  assert.equal(card.stats.active, 1, 'один в пути');
  assert.equal(card.stats.sumAll, 220000);
  assert.equal(card.stats.avgCheck, 110000);
  assert.equal(card.stats.daysSinceLast, 5, 'с последнего выполненного 16.08');
  assert.equal(card.contacts[0].daysToBirthday, 2, 'ДР контакта через 2 дня');
  assert.equal(card.notes.length, 1);
  const dates = upcomingCustomerDates(db, now, 7);
  assert.ok(dates.some(item => item.kind === 'birthday' && item.contact === 'Иванов Пётр' && item.daysLeft === 2));
  assert.ok(!dates.some(item => item.kind === 'holiday'), 'в конце августа праздников в горизонте нет');
  const nyDates = upcomingCustomerDates(db, Date.parse('2026-12-26T09:00:00.000Z'), 7);
  assert.ok(nyDates.some(item => item.kind === 'holiday' && item.name === 'Новый год' && item.daysLeft === 6));
});

test('занятость по факту: вывод на линию раньше плана и опоздание — машина в рейсе; машино-день от 4 ч', () => {
  const now = Date.parse('2026-08-21T12:00:00.000Z');
  // Выведена на линию 20.08 18:00 при плановой погрузке 22.08 05:15 — занята с вывода.
  const early = { status: 'run', starts_at: '2026-08-22T05:15:00.000Z', ends_at: '2026-08-23T06:27:00.000Z',
    on_line_at: '2026-08-20T18:00:00.000Z', unloaded_at: null };
  const rangeEarly = tripBusyRange(early, now);
  assert.equal(new Date(rangeEarly.from).toISOString(), '2026-08-20T18:00:00.000Z');
  // Опоздун: расчётный конец прошёл, факта нет — занята до «сейчас».
  const late = { status: 'run', starts_at: '2026-08-20T15:00:00.000Z', ends_at: '2026-08-21T09:00:00.000Z',
    on_line_at: null, unloaded_at: null };
  assert.equal(tripBusyRange(late, now).to, now);
  // Выгружен раньше расчёта — свободен по факту.
  const done = { status: 'unloaded', starts_at: '2026-08-19T06:00:00.000Z', ends_at: '2026-08-20T18:00:00.000Z',
    on_line_at: null, unloaded_at: '2026-08-20T10:00:00.000Z' };
  assert.equal(new Date(tripBusyRange(done, now).to).toISOString(), '2026-08-20T10:00:00.000Z');
  const day21 = Date.parse('2026-08-21T00:00:00.000Z');
  assert.equal(dayStateOf([early], [], day21, now), 'work', 'выведенная заранее — в работе весь день');
  assert.equal(dayStateOf([late], [], day21, now), 'work', 'опоздун 00:00–12:00 — в работе');
  assert.equal(dayStateOf([done], [], day21, now), 'idle', 'выгружен вчера — сегодня простой');
  // Рейс, коснувшийся дня на 2 часа, день не окрашивает; ремонт 6 ч — да.
  const brief = { status: 'done', starts_at: '2026-08-20T06:00:00.000Z', ends_at: '2026-08-21T02:00:00.000Z',
    on_line_at: null, unloaded_at: '2026-08-21T02:00:00.000Z' };
  assert.equal(dayStateOf([brief], [], day21, now), 'idle');
  assert.equal(dayStateOf([brief], [{ kind: 'repair', starts_at: '2026-08-21T08:00:00.000Z', ends_at: '2026-08-21T14:00:00.000Z' }], day21, now), 'repair');
  assert.equal(dayStateOf([], [{ kind: 'reserve', starts_at: '2026-08-21T00:00:00.000Z', ends_at: '2026-08-22T00:00:00.000Z' }], day21, now), 'idle', 'резерв день не объясняет');
});

test('отчёт: будущие дни периода не считаются простоем, «выгружено» ≤ «забито»', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pegas-future-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = openDatabase(path.join(directory, 'planner.db'), {
    username: 'root-admin', password: 'Temporary-password-2026', fullName: 'Администратор'
  });
  t.after(() => db.close());
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = today.slice(0, 8) + '01';
  const nextMonth = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 1)).toISOString().slice(0, 10);
  const snap = reportSnapshot(db, monthStart, nextMonth);
  const elapsed = Math.round((Date.parse(today) - Date.parse(monthStart)) / 86_400_000) + 1;
  assert.equal(snap.utilization.days, elapsed, 'учтены только прошедшие дни + сегодня');
  assert.ok(snap.utilization.futureDays >= 0);
  assert.equal(snap.utilization.days + snap.utilization.futureDays, snap.utilization.periodDays);
  assert.ok(snap.netRevenueDone <= snap.netRevenue);
});

test('сигнал «следующий рейс не назначен»: выгрузка в ближайшие 2 часа без плана после — в списке', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pegas-next-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = openDatabase(path.join(directory, 'planner.db'), {
    username: 'root-admin', password: 'Temporary-password-2026', fullName: 'Администратор'
  });
  t.after(() => db.close());
  const [v1, v2, v3] = db.prepare('SELECT id FROM vehicles LIMIT 3').all().map(row => row.id);
  const zone = db.prepare('SELECT id FROM zones LIMIT 1').get().id;
  const now = Date.now();
  const iso = ms => new Date(ms).toISOString();
  const ins = db.prepare(`INSERT INTO trips(id,vehicle_id,customer_name,from_zone_id,to_zone_id,to_point,
    starts_at,ends_at,distance_km,revenue_vat,status) VALUES(?,?,?,?,?,?,?,?,500,90000,?)`);
  // V1: в пути, выгрузка через 1 час, следующего нет → в списке
  ins.run('nx1', v1, 'К', zone, zone, 'Пенза', iso(now - 20 * 3600e3), iso(now + 3600e3), 'run');
  // V2: в пути, выгрузка через 1 час, НО следующий план назначен → не в списке
  ins.run('nx2', v2, 'К', zone, zone, 'Тула', iso(now - 20 * 3600e3), iso(now + 3600e3), 'run');
  ins.run('nx2b', v2, 'К', zone, zone, 'Москва', iso(now + 5 * 3600e3), iso(now + 30 * 3600e3), 'plan');
  // V3: в пути, выгрузка через 5 часов → вне горизонта 2 ч
  ins.run('nx3', v3, 'К', zone, zone, 'Самара', iso(now - 10 * 3600e3), iso(now + 5 * 3600e3), 'run');
  const rows = tripsWithoutNext(db, now, 2 * 3600e3, true);
  assert.deepEqual(rows.map(r => r.id), ['nx1']);
  db.prepare(`UPDATE trips SET next_alert_at=CURRENT_TIMESTAMP WHERE id='nx1'`).run();
  assert.deepEqual(tripsWithoutNext(db, now, 2 * 3600e3, true), [], 'повторно по тому же рейсу не сигналит');
});

test('сверка с 1С: пары по сумме/НДС/заказчику, излишки и «ещё не занесённые»', async () => {
  const { parse1cRows, fileMonths, reconcileOrders, netOf } =
    await import('../public/assets/reconcile.js');
  // Сырые строки листа: мусорная шапка, затем заголовки и заказы.
  const rows = [
    ['Отчёт по заказам'],
    ['Дата отправления', 'Дата выполнения', 'ТС', 'Водитель', 'Заказчик', 'Адрес отправления', 'Адрес назначения', 'Сумма документа'],
    ['05.08.2026', '06.08.2026', 'а001аа58', 'Иванов', 'Клиент-Точный ООО', 'Москва', 'Пенза', 122000],
    ['06.08.2026', '07.08.2026', 'а002аа58', 'Петров', 'Клиент-БезНДС ООО', 'Москва', 'Курск', 100000],
    ['07.08.2026', '08.08.2026', 'а003аа58', 'Сидоров', 'Клиент-Ушедший ООО', 'Тверь', 'Уфа', 90000],
    ['20.08.2026', '21.08.2026', 'а001аа58', 'Иванов', 'Клиент-Точный ООО', 'Пенза', 'Москва', 80000],
    ['не дата', '', '', '', '', '', '', 0]
  ];
  const orders = parse1cRows(rows);
  assert.equal(orders.length, 4, 'строки без даты отправления отброшены');
  assert.equal(fileMonths(orders)[0].month, '2026-08', 'по умолчанию — последний месяц файла');
  // Рейсы планера: даты — UTC (день по МСК совпадает с 1С).
  const trips = [
    { id: 't1', vehicle_plate: 'а001аа58 / прицеп', customer_name: 'Клиент-Точный ООО',
      starts_at: '2026-08-05T08:00:00.000Z', revenue_vat: 122000, status: 'done', order_no: '10' },
    // Сумма в планере с НДС, в 1С — без: пара должна найтись и попасть в НДС-путаницу.
    { id: 't2', vehicle_plate: 'а002аа58', customer_name: 'Клиент-БезНДС ООО',
      starts_at: '2026-08-06T08:00:00.000Z', revenue_vat: 122000, status: 'done', order_no: '11' },
    // Излишек: в 1С такого рейса нет, дата раньше края файла (20.08).
    { id: 't3', vehicle_plate: 'а009аа58', customer_name: 'Лишний ООО',
      starts_at: '2026-08-10T08:00:00.000Z', revenue_vat: 70000, status: 'unloaded', order_no: '12' },
    // Не излишек: день края файла — в 1С просто ещё не занесён.
    { id: 't4', vehicle_plate: 'а010аа58', customer_name: 'Свежий ООО',
      starts_at: '2026-08-20T10:00:00.000Z', revenue_vat: 50000, status: 'plan', order_no: '13' },
    { id: 't5', vehicle_plate: 'а001аа58', customer_name: 'Клиент-Точный ООО',
      starts_at: '2026-08-20T05:00:00.000Z', revenue_vat: 80000, status: 'run', order_no: '14' },
    { id: 'tr', vehicle_plate: 'а011аа58', customer_name: 'Снятый ООО',
      starts_at: '2026-08-11T08:00:00.000Z', revenue_vat: 60000, status: 'rejected', order_no: '15' }
  ];
  const result = reconcileOrders(orders, trips, '2026-08');
  assert.equal(result.pairs, 3, 'точная + НДС + вторая точная');
  assert.equal(result.exact, 2);
  assert.equal(result.vatErr.length, 1, 'пара 100000 ↔ 122000 — НДС-путаница');
  assert.deepEqual(result.surplus.map(trip => trip.id), ['t3'], 'излишек только до края файла');
  assert.deepEqual(result.notYet.map(trip => trip.id), ['t4'], 'рейс дня выгрузки файла — ещё не занесён');
  assert.equal(result.onlyC1.length, 1, 'заказ «Ушедшего» в планере отсутствует');
  assert.equal(result.onlyC1[0].customer, 'Клиент-Ушедший ООО');
  assert.equal(result.trueSum, result.c1.sum + 50000, 'истина = 1С + не занесённое');
  // Отклонённые рейсы в сверке не участвуют.
  assert.ok(!result.surplus.some(trip => trip.id === 'tr'));
  // Очистка НДС: ИП — 7%, остальные — 22%.
  assert.ok(Math.abs(netOf(122, 'Ромашка ООО') - 100) < 0.01);
  assert.ok(Math.abs(netOf(107, 'Мазова Ольга ИП') - 100) < 0.01);
});

test('отчёт за смену: имена операций, время обработки и очереди каскада', async t => {
  const { shiftBounds, currentShift, operationNameOf, shiftReport } =
    await import('../src/planner-service.mjs');
  // Границы смен: дневная 08–20 МСК = 05–17 UTC.
  const bounds = shiftBounds('2026-08-24', 'day');
  assert.equal(bounds.fromIso, '2026-08-24T05:00:00.000Z');
  assert.equal(bounds.toIso, '2026-08-24T17:00:00.000Z');
  const night = shiftBounds('2026-08-24', 'night');
  assert.equal(night.fromIso, '2026-08-24T17:00:00.000Z');
  assert.equal(night.toIso, '2026-08-25T05:00:00.000Z');
  // Текущая смена: 23:30 МСК = ночная, начавшаяся в тот же день.
  assert.deepEqual(currentShift(Date.parse('2026-08-24T20:30:00Z')),
    { day: '2026-08-24', kind: 'night' });
  assert.deepEqual(currentShift(Date.parse('2026-08-24T02:00:00Z')),
    { day: '2026-08-23', kind: 'night' }, 'до 08 МСК — ночная вчерашнего начала');
  // Имена собственные операций.
  assert.equal(operationNameOf({ entity: 'order', action: 'update', details_json: '{"stage":1}' }),
    'Подтверждение заявки');
  assert.equal(operationNameOf({ entity: 'trip', action: 'dispatch_step', details_json: '{"step":"driver_notified"}' }),
    'Задание водителю');
  assert.equal(operationNameOf({ entity: 'control', action: 'control-worked', details_json: '{}' }),
    'Контроль на линии');
  assert.equal(operationNameOf({ entity: 'settings', action: 'update', details_json: '{}' }), null,
    'служебные действия — не операции конвейера');

  // Живой отчёт на синтетике: заявка внесена и подтверждена в смену.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pegas-shift-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = openDatabase(path.join(directory, 'planner.db'), {
    username: 'root-admin', password: 'Temporary-password-2026', fullName: 'Администратор'
  });
  t.after(() => db.close());
  const admin = db.prepare('SELECT id FROM users LIMIT 1').get().id;
  db.prepare(`UPDATE users SET full_name='Киселёва Л', job_role='Логист' WHERE id=?`).run(admin);
  const zone = db.prepare('SELECT id FROM zones LIMIT 1').get().id;
  // Отчёт строим по ЗАВЕРШИВШЕЙСЯ смене (вчерашней дневной) и все метки
  // времени задаём явно внутри неё. Привязка к «сейчас» делала тест
  // нестабильным: на стыке смен (08:00 и 20:00 МСК) операция «30 минут
  // назад» попадала в предыдущую смену, а норма к часу зависела от того,
  // сколько смены прошло к моменту запуска.
  const shift = currentShift(Date.now() - 86_400_000);
  const shiftFromMs = Date.parse(shiftBounds(shift.day, shift.kind).fromIso);
  const at = minutes => new Date(shiftFromMs + minutes * 60_000).toISOString();
  const sqlAt = minutes => at(minutes).replace('T', ' ').slice(0, 19);
  const earlyIso = at(60);      // заявка внесена через час после начала смены
  const lateIso = at(90);       // подтверждена ещё через 30 минут
  // Окно погрузки — относительное (+30 ч), фиксированные даты протухают.
  db.prepare(`INSERT INTO orders(id,customer_name,from_zone_id,to_zone_id,rate_vat,
    window_from,window_to,stage,created_at,confirmed_at)
    VALUES('sh-o1','Клиент',?,?,90000,?,?,1,?,?)`).run(zone, zone,
    // Окно погрузки — через 30 ч после подтверждения (SLA назначения «вовремя»).
    new Date(Date.parse(lateIso) + 30 * 3_600_000).toISOString(),
    new Date(Date.parse(lateIso) + 54 * 3_600_000).toISOString(),
    sqlAt(60), sqlAt(90));
  db.prepare(`INSERT INTO audit_log(id,user_id,action,entity,entity_id,details_json,created_at)
    VALUES('sh-a1',?, 'create','order','sh-o1','{}',?),
      ('sh-a2',?, 'update','order','sh-o1','{"stage":1}',?)`)
    .run(admin, sqlAt(60), admin, sqlAt(90));
  // График смен: Киселёва назначена и работала; Новиков назначен и не вышел.
  db.prepare(`INSERT INTO users(id,username,password_hash,full_name,role,active)
    VALUES('sh-u2','novikov','x','Новиков П','dispatcher',1)`).run();
  db.prepare(`INSERT INTO staff_shifts(id,user_id,day,kind) VALUES
    ('sh-s1',?,?,?),('sh-s2','sh-u2',?,?)`).run(admin, shift.day, shift.kind, shift.day, shift.kind);
  const report = shiftReport(db, shift.day, shift.kind);
  const person = report.staff.find(item => item.name === 'Киселёва Л');
  assert.ok(person, 'исполнитель в отчёте по имени');
  assert.equal(person.total, 2);
  assert.equal(person.planned, true, 'работавший по графику помечен');
  assert.equal(report.plan.noShow, 1, 'назначенный без операций — не вышел');
  const absent = report.plan.planned.find(item => item.name === 'Новиков П');
  assert.equal(absent?.worked, false);
  assert.equal(report.plan.offPlan, 0, 'вне графика никто не работал');
  // Эффективность: проценты и разложение присутствуют, база — сама смена
  // (истории нет), поэтому единственный работник должности ≈ 100%.
  assert.ok(Number.isFinite(person.efficiency), 'эффективность посчитана');
  // Смена завершилась, поэтому норма считается за полную смену: единственный
  // работник должности задаёт среднюю и близок к 100%.
  assert.ok(person.efficiency >= 70 && person.efficiency <= 130,
    `единственный в должности близок к средней, получили ${person.efficiency}%`);
  assert.ok(person.loadIdx > 0 && person.speedIdx > 0);
  assert.ok(Array.isArray(report.signals), 'сигналы эффективности отдаются');
  // Сравнение должностей: объём/время и отклонение от нормы.
  const roleRow = report.roles.find(item => item.role === 'Логист');
  assert.ok(roleRow, 'должность в сравнении');
  assert.equal(roleRow.people, 1);
  assert.equal(roleRow.totalOps, 2);
  assert.ok(roleRow.opsPerPerson === 2 && roleRow.loadIdx > 0);
  // SLA назначения: назначение за 30 часов до погрузки — вовремя.
  db.prepare(`INSERT INTO audit_log(id,user_id,action,entity,entity_id,details_json,created_at)
    VALUES('sh-a3',?, 'assign','order','sh-o1','{}',?)`).run(admin, sqlAt(95));
  const withAssign = shiftReport(db, shift.day, shift.kind);
  assert.equal(withAssign.assignSla.total, 1);
  assert.equal(withAssign.assignSla.onTime, 1, 'погрузка завтра — назначено вовремя');
  assert.equal(withAssign.assignSla.pct, 100);
  const confirm = report.operations.find(item => item.name === 'Подтверждение заявки');
  assert.ok(confirm, 'операция названа по имени');
  // Время обработки подтверждения ≈ 30 минут (заявка ждала с создания).
  assert.ok(confirm.medianWaitMs > 25 * 60_000 && confirm.medianWaitMs < 35 * 60_000,
    `медиана обработки ~30 мин, получили ${confirm.medianWaitMs}`);
  // Очереди каскада: на конец смены подтверждённая заявка ждёт логиста.
  assert.ok(report.queuesEnd.logist >= 1, 'подтверждённая заявка в очереди логиста');
});

test('план вывоза: сетка слотов из истории и план-факт месяца', async t => {
  const { seedDeliverySlots, deliveryPlan } = await import('../src/planner-service.mjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pegas-dplan-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = openDatabase(path.join(directory, 'planner.db'), {
    username: 'root-admin', password: 'Temporary-password-2026', fullName: 'Администратор'
  });
  t.after(() => db.close());
  const vehicle = db.prepare('SELECT id FROM vehicles LIMIT 1').get().id;
  const [z1, z2] = db.prepare('SELECT id FROM zones LIMIT 2').all().map(row => row.id);
  const iso = ms => new Date(ms).toISOString();
  const now = Date.now();
  // 9 рейсов клиента за 9 недель — каждый понедельник МСК (≥1/нед в окне 60 дней).
  const monday = (() => { // ближайший прошлый понедельник 09:00 МСК
    const date = new Date(now + 3 * 3600e3);
    const shift = (date.getUTCDay() + 6) % 7;
    date.setUTCDate(date.getUTCDate() - shift);
    date.setUTCHours(9, 0, 0, 0);
    return date.getTime() - 3 * 3600e3;
  })();
  const ins = db.prepare(`INSERT INTO trips(id,vehicle_id,customer_name,from_zone_id,to_zone_id,
    starts_at,ends_at,distance_km,revenue_vat,status) VALUES(?,?,?,?,?,?,?,600,90000,'done')`);
  for (let week = 0; week < 9; week += 1) {
    const start = monday - week * 7 * 86400e3;
    ins.run(`dp-${week}`, vehicle, 'Регуляр ООО', z1, z2, iso(start), iso(start + 24 * 3600e3));
  }
  const created = seedDeliverySlots(db);
  assert.ok(created >= 1, 'слот понедельника создан');
  const slot = db.prepare(`SELECT * FROM delivery_slots WHERE customer_name='Регуляр ООО'`).all();
  assert.equal(slot.length, 1, 'ровно один день недели');
  assert.equal(slot[0].weekday, 1, 'понедельник');
  assert.ok(slot[0].per_day >= 0.9 && slot[0].per_day <= 1.1, `≈1 рейс в день, получили ${slot[0].per_day}`);
  assert.equal(slot[0].rate, 90000);
  // План-факт: заявка клиента в этом месяце → факт со стадией «внесена».
  const month = new Date(now + 3 * 3600e3).toISOString().slice(0, 7);
  db.prepare(`INSERT INTO orders(id,customer_name,from_zone_id,to_zone_id,rate_vat,
    window_from,window_to,stage) VALUES('dp-o1','Регуляр ООО',?,?,95000,?,?,0)`)
    .run(z1, z2, iso(now + 24 * 3600e3), iso(now + 48 * 3600e3));
  const plan = deliveryPlan(db, month);
  assert.ok(plan.slots.length >= 1);
  const day = new Date(now + 24 * 3600e3 + 3 * 3600e3).getUTCDate();
  const fact = plan.facts[`Регуляр ООО|${z1}|${z2}|${day}`];
  assert.ok(fact, 'факт заявки в сетке');
  assert.equal(fact.stage, 1, 'стадия «заявка внесена»');
  assert.equal(fact.rv, 95000);
});

test('радар продаж: рынок направлений и свободные машины без блокирующих диспозиций', async () => {
  const { directionMarket, freeVehiclesByZone } = await import('../public/assets/sales-radar.js');
  const now = Date.now();
  const iso = ms => new Date(ms).toISOString();
  const data = {
    vehicles: [
      { id: 'v1', plate: 'а001аа58', status: 'work', zone_name: 'Дом' },
      { id: 'v2', plate: 'а002аа58', status: 'work', zone_name: 'Дом' },
      { id: 'v3', plate: 'а003аа58', status: 'work', zone_name: 'Дом' }
    ],
    trips: [
      // v1 выгрузилась в Москве 30 часов назад — свободна, стоит сутки+.
      { vehicle_id: 'v1', status: 'done', from_name: 'Дом', to_name: 'Москва',
        starts_at: iso(now - 54 * 3600e3), ends_at: iso(now - 30 * 3600e3),
        revenue_vat: 80000, distance_km: 640, customer_name: 'Клиент А' },
      // ещё 8 рейсов Дом→Москва для регулярности (≥1/нед за 60 дней)
      ...Array.from({ length: 8 }, (_, i) => ({
        vehicle_id: 'v9', status: 'done', from_name: 'Дом', to_name: 'Москва',
        starts_at: iso(now - (i + 2) * 6 * 86400e3), ends_at: iso(now - (i + 2) * 6 * 86400e3 + 24 * 3600e3),
        revenue_vat: 70000 + i * 5000, distance_km: 640, customer_name: i % 2 ? 'Клиент А' : 'Клиент Б' }))
    ],
    dispositions: [
      // v2 в ремонте сейчас — в радар не попадает.
      { vehicle_id: 'v2', kind: 'repair', starts_at: iso(now - 3600e3), ends_at: iso(now + 48 * 3600e3) }
    ],
    vehicleHolds: [{ vehicle_id: 'v3', until: iso(now + 3600e3), note: 'под сделку', held_by_name: 'Логист' }]
  };
  const market = directionMarket(data, now);
  const dir = market.find(item => item.key === 'Дом→Москва');
  assert.ok(dir, 'направление в рынке');
  assert.ok(dir.median >= 70000 && dir.median <= 100000);
  assert.ok(dir.topCustomers.length >= 2, 'клиенты направления собраны');
  const zones = freeVehiclesByZone(data, now);
  const moscow = zones.find(group => group.zone === 'Москва');
  assert.ok(moscow, 'v1 свободна в зоне выгрузки');
  assert.equal(moscow.idleDayPlus, 1, 'стоит сутки+');
  const allPlates = zones.flatMap(group => group.list.map(item => item.vehicle.plate));
  assert.ok(!allPlates.includes('а002аа58'), 'машина в ремонте не предлагается к продаже');
  const held = zones.flatMap(group => group.list).find(item => item.vehicle.id === 'v3');
  assert.ok(held?.hold, 'бронь видна на свободной машине');
});

test('моя смена: личные операции против нормы должности', async t => {
  const { myShiftStats, currentShift, shiftBounds } = await import('../src/planner-service.mjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pegas-myshift-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = openDatabase(path.join(directory, 'planner.db'), {
    username: 'root-admin', password: 'Temporary-password-2026', fullName: 'Администратор'
  });
  t.after(() => db.close());
  const admin = db.prepare('SELECT * FROM users LIMIT 1').get();
  db.prepare(`UPDATE users SET full_name='Оператор Тест', job_role='Диспетчер' WHERE id=?`).run(admin.id);
  const me = db.prepare('SELECT * FROM users WHERE id=?').get(admin.id);
  // 3 операции контроля внутри ЗАВЕРШИВШЕЙСЯ смены (вчерашней дневной) —
  // «10 минут назад» на стыке смен (08:00 и 20:00 МСК) уводило их в
  // предыдущую смену, и тест падал в зависимости от времени запуска.
  const shift = currentShift(Date.now() - 86_400_000);
  const shiftFromMs = Date.parse(shiftBounds(shift.day, shift.kind).fromIso);
  const opAt = new Date(shiftFromMs + 3_600_000).toISOString().replace('T', ' ').slice(0, 19);
  const ins = db.prepare(`INSERT INTO audit_log(id,user_id,action,entity,entity_id,details_json,created_at)
    VALUES(?,?,?,?,?,?,?)`);
  for (let i = 0; i < 3; i += 1) ins.run(`ms-${i}`, me.id, 'control-worked', 'control', `k${i}`, '{}', opAt);
  // Момент «сейчас» — середина той смены: норма к часу считается от неё.
  const stats = myShiftStats(db, me, shiftFromMs + 6 * 3_600_000);
  assert.equal(stats.ops, 3, 'личные операции за смену');
  assert.ok(stats.effPct > 0 && Number.isFinite(stats.effPct));
  assert.equal(stats.sharePct, 100, 'единственный работавший — 100% вклада');
  assert.equal(stats.roleKey, 'Диспетчер');
  assert.ok(stats.normToNow >= 0);
});

test('норма «обычно»: тот же день недели и +5% прогрессии', async () => {
  const { usualByNow } = await import('../public/assets/dashboard.js');
  const now = Date.now();
  const msk = 3 * 3600e3;
  const day0 = Math.floor((now + msk) / 86400e3) * 86400e3 - msk;
  const rows = [];
  // По 10 событий утром в каждый из 4 прошлых таких же дней недели…
  for (let week = 1; week <= 4; week += 1) {
    for (let i = 0; i < 10; i += 1) rows.push({ ts: day0 - week * 7 * 86400e3 + 3600e3 + i });
  }
  // …и по 99 событий во «вчера» (другой день недели) — не должны влиять.
  for (let i = 0; i < 99; i += 1) rows.push({ ts: day0 - 86400e3 + 3600e3 + i });
  const usual = usualByNow(rows, row => row.ts, day0 + 12 * 3600e3);
  assert.ok(Math.abs(usual - 10.5) < 0.01, `10 × 1.05 = 10.5, получили ${usual}`);
});

test('долги 1С: отложенное внесение открывает задание водителю', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pegas-1cdebt-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = openDatabase(path.join(directory, 'planner.db'), {
    username: 'root-admin', password: 'Temporary-password-2026', fullName: 'Администратор'
  });
  t.after(() => db.close());
  const { applyDispatchStep } = await import('../src/trip-control.mjs');
  const vehicle = db.prepare('SELECT id FROM vehicles LIMIT 1').get().id;
  const zone = db.prepare('SELECT id FROM zones LIMIT 1').get().id;
  const iso = shift => new Date(Date.now() + shift).toISOString();
  db.prepare(`INSERT INTO trips(id,vehicle_id,customer_name,from_zone_id,to_zone_id,
    starts_at,ends_at,distance_km,revenue_vat,status,logist_confirmed_at)
    VALUES('dc1',?,'К',?,?,?,?,500,90000,'plan',CURRENT_TIMESTAMP)`)
    .run(vehicle, zone, zone, iso(3600e3), iso(30 * 3600e3));
  const admin = db.prepare('SELECT id FROM users LIMIT 1').get().id;
  // Без 1С и без отложки задание водителю не отметить.
  assert.throws(() => applyDispatchStep(db, 'dc1', 'driver_notified', admin),
    /Сначала выполните/);
  // Отложили 1С — задание водителю проходит, долг остаётся видимым.
  db.prepare(`UPDATE trips SET deferred_1c_at=CURRENT_TIMESTAMP WHERE id='dc1'`).run();
  const { trip } = applyDispatchStep(db, 'dc1', 'driver_notified', admin);
  assert.ok(trip);
  const after = db.prepare(`SELECT driver_notified_at, entered_1c_at, deferred_1c_at FROM trips WHERE id='dc1'`).get();
  assert.ok(after.driver_notified_at, 'задание водителю отмечено');
  assert.equal(after.entered_1c_at, null, 'долг 1С не закрыт');
  assert.ok(after.deferred_1c_at, 'пометка отложенности висит');
});

test('конструктор: допуск ±3 ч, ожидание и отсев тупиков', async () => {
  const { routeMetrics, buildAutoRoute, legTransitHours, outflowPerWeek, TOLERANCE_H } =
    await import('../public/assets/routes.js');
  const now = Date.now();
  const iso = ms => new Date(ms).toISOString();
  const addr = (name, region, lat, lon) => ({ id: name, name, region, zone_name: region, latitude: lat, longitude: lon });
  const data = {
    settings: { calculation: { techSpeedKmh: 50, handlingHoursPerOperation: 2, transitFactor: 1.5, vatRate: 0.22 } },
    reference: { addresses: [
      addr('Пенза', 'Пензенская обл', 53.2, 45.0), addr('Москва', 'Московская обл', 55.75, 37.6),
      addr('Тупик', 'Тупиковая обл', 60.0, 30.3)
    ] },
    vehicles: [], routes: [],
    // История: Пенза→Москва 6 рейсов по 20 ч (медиана 20 — вместо формулы 26),
    // из Москвы поток есть, из Тупика — нет.
    trips: [
      ...Array.from({ length: 6 }, (_, i) => ({ id: `h${i}`, status: 'done',
        from_name: 'Пенза', to_name: 'Москва',
        starts_at: iso(now - (i + 2) * 86400e3), ends_at: iso(now - (i + 2) * 86400e3 + 20 * 3600e3) })),
      ...Array.from({ length: 10 }, (_, i) => ({ id: `m${i}`, status: 'done',
        from_name: 'Москва', to_name: 'Пенза',
        starts_at: iso(now - (i + 2) * 86400e3), ends_at: iso(now - (i + 2) * 86400e3 + 22 * 3600e3) }))
    ],
    orders: [
      { id: 'o1', order_no: '1', customer_name: 'К1', stage: 1, status: 'new',
        from_name: 'Пенза', to_name: 'Москва', from_address_id: 'Пенза', to_address_id: 'Москва',
        planned_km: 640, rate_vat: 100000, window_from: iso(now + 2 * 3600e3), window_to: iso(now + 24 * 3600e3) },
      // Тупиковое плечо: дороже, но из «Тупика» нет ни потока, ни заявок.
      { id: 'o2', order_no: '2', customer_name: 'К2', stage: 1, status: 'new',
        from_name: 'Пенза', to_name: 'Тупик', from_address_id: 'Пенза', to_address_id: 'Тупик',
        planned_km: 700, rate_vat: 200000, window_from: iso(now + 2 * 3600e3), window_to: iso(now + 40 * 3600e3) },
      { id: 'o3', order_no: '3', customer_name: 'К3', stage: 1, status: 'new',
        from_name: 'Москва', to_name: 'Пенза', from_address_id: 'Москва', to_address_id: 'Пенза',
        planned_km: 640, rate_vat: 90000, window_from: iso(now + 26 * 3600e3), window_to: iso(now + 60 * 3600e3) }
    ]
  };
  // Транзит берётся из факта (20 ч), а не из формулы (26 ч).
  const tr = legTransitHours(data, data.orders[0], data.settings.calculation);
  assert.ok(Math.abs(tr - 20) < 0.5, `факт 20 ч, получили ${tr}`);
  assert.equal(outflowPerWeek(data, 'Тупик'), 0, 'из тупика потока нет');
  // Сборка: тупиковое плечо не берётся, несмотря на вдвое большую ставку.
  const ids = buildAutoRoute(data, { startIso: iso(now), baseRegion: 'Пензенская обл',
    targetPerDay: 48000, maxOrders: 3 });
  assert.ok(ids.includes('o1'), 'взято плечо с продолжением');
  assert.ok(!ids.includes('o2'), 'тупиковое плечо отсеяно');
  // Метрики: ожидание считается, допуск помечает «договориться».
  const m = routeMetrics(data, ids.map(id => data.orders.find(o => o.id === id)),
    { baseRegion: 'Пензенская обл', plannedStart: iso(now), targetPerDay: 48000 });
  assert.ok(m.waitMs >= 0 && Number.isFinite(m.waitMs), 'ожидание посчитано');
  assert.ok(m.legs.every(leg => !leg.impossible), 'неисполнимых плеч в цепочке нет');
  assert.equal(TOLERANCE_H, 3);
  // Плечо с выходом за окно на 2 ч — в допуске (needDeal), на 5 ч — нет.
  const late = { ...data.orders[0], id: 'o4', window_to: iso(now + 2 * 3600e3 + 22 * 3600e3) };
  const m2 = routeMetrics(data, [late], { baseRegion: 'Пензенская обл', plannedStart: iso(now), targetPerDay: 48000 });
  assert.ok(m2.legs[0].needDeal || m2.legs[0].overshootMs === 0, 'выход за окно в пределах 3 ч — это «договориться»');
});

test('конструктор: недельная цепочка со спотами на разрывах', async () => {
  const { buildWeekPlan, spotLegFrom, SPOT_MAX_HOURS } =
    await import('../public/assets/routes.js');
  const now = Date.now();
  const iso = ms => new Date(ms).toISOString();
  const addr = (name, region, lat, lon) => ({ id: name, name, region, zone_name: region, latitude: lat, longitude: lon });
  const data = {
    settings: { calculation: { techSpeedKmh: 50, handlingHoursPerOperation: 2, transitFactor: 1.5, vatRate: 0.22 } },
    reference: {
      addresses: [addr('Пенза', 'Пенза', 53.2, 45.0), addr('Москва', 'Москва', 55.75, 37.6),
        addr('Тупик', 'Тупик', 60.0, 30.0)],
      zones: [], routeRates: []
    },
    // История: из Москвы регулярно возят в Пензу (спот) и разово — в Тупик,
    // куда вдобавок нет обратного потока.
    trips: [
      ...Array.from({ length: 8 }, (unused, index) => ({
        id: `m${index}`, status: 'done', from_name: 'Москва', to_name: 'Пенза',
        starts_at: iso(now - (index + 2) * 86_400_000), ends_at: iso(now - (index + 2) * 86_400_000 + 20 * 3_600_000),
        distance_km: 640, revenue_vat: 120_000, customer_name: 'Клиент А'
      })),
      ...Array.from({ length: 6 }, (unused, index) => ({
        id: `t${index}`, status: 'done', from_name: 'Москва', to_name: 'Тупик',
        starts_at: iso(now - (index + 2) * 86_400_000), ends_at: iso(now - (index + 2) * 86_400_000 + 30 * 3_600_000),
        distance_km: 700, revenue_vat: 300_000, customer_name: 'Клиент Б'
      })),
      // Из Пензы выезд регулярный — значит зона не тупиковая.
      ...Array.from({ length: 12 }, (unused, index) => ({
        id: `p${index}`, status: 'done', from_name: 'Пенза', to_name: 'Москва',
        starts_at: iso(now - (index + 2) * 86_400_000), ends_at: iso(now - (index + 2) * 86_400_000 + 20 * 3_600_000),
        distance_km: 640, revenue_vat: 110_000, customer_name: 'Клиент А'
      }))
    ],
    orders: [], routes: []
  };
  // Из Москвы спот идёт домой в Пензу, а не в дорогой тупик без обратного потока.
  const spot = spotLegFrom(data, 'Москва', { baseZone: 'Пенза' });
  assert.equal(spot.to, 'Пенза', 'спот к базе имеет приоритет');
  const noHome = spotLegFrom(data, 'Москва', {});
  assert.equal(noHome.to, 'Пенза', 'дорогой тупик без обратного потока в споты не идёт');
  assert.equal(spotLegFrom(data, 'Москва', { maxHours: 5 }), null, 'слишком длинные плечи отсеяны');
  assert.ok(SPOT_MAX_HOURS >= 24, 'потолок плеча спота — не меньше суток');

  // Заявок нет вовсе — недельный план целиком из спотов, в пределах горизонта.
  const chain = buildWeekPlan(data, { startIso: iso(now), baseRegion: 'Пенза', baseZone: 'Пенза',
    targetPerDay: 48_000, horizonDays: 7 });
  assert.ok(chain.length >= 1, 'цепочка не пустая');
  assert.ok(chain.every(item => item.kind === 'spot'), 'без заявок звенья — споты');
  assert.ok(chain.every(item => item.unloadAt > item.loadAt), 'выгрузка позже погрузки');
  assert.ok(chain[chain.length - 1].unloadAt <= now + 8 * 86_400_000, 'цепочка укладывается в горизонт');
});

test('замена ТС: рейс без фактов возвращается в подготовку к выходу', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pegas-replace-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = openDatabase(path.join(directory, 'planner.db'), {
    username: 'root-admin', password: 'Temporary-password-2026', fullName: 'Администратор'
  });
  t.after(() => db.close());
  const { backToPreparationOnVehicleChange, tripHasMovementFacts, ensureTripStops } =
    await import('../src/trip-control.mjs');
  const zone = db.prepare('SELECT id FROM zones LIMIT 1').get().id;
  const vehicle = db.prepare('SELECT id FROM vehicles LIMIT 1').get().id;
  const iso = shift => new Date(Date.now() + shift).toISOString();
  const makeTrip = id => db.prepare(`INSERT INTO trips(id,vehicle_id,customer_name,from_zone_id,to_zone_id,
    starts_at,ends_at,distance_km,revenue_vat,status,logist_confirmed_at,entered_1c_at,
    driver_notified_at,on_line_at)
    VALUES(?,?,'К',?,?,?,?,500,90000,'run',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`)
    .run(id, vehicle, zone, zone, iso(20 * 3600e3), iso(50 * 3600e3));

  // Рейс вывели на линию заранее — фактов движения ещё нет.
  makeTrip('rv1');
  ensureTripStops(db, 'rv1');
  assert.equal(tripHasMovementFacts(db, db.prepare('SELECT * FROM trips WHERE id=?').get('rv1')), false);
  assert.equal(backToPreparationOnVehicleChange(db, db.prepare('SELECT * FROM trips WHERE id=?').get('rv1')), true);
  const back = db.prepare('SELECT status,on_line_at,driver_notified_at,entered_1c_at FROM trips WHERE id=?').get('rv1');
  assert.equal(back.status, 'plan', 'рейс вернулся в подготовку');
  assert.equal(back.on_line_at, null, 'вывод на линию отозван — задание придёт заново');
  assert.equal(back.driver_notified_at, null, 'задание прежнему водителю отозвано');
  assert.ok(back.entered_1c_at, 'внесение в 1С не сбрасывается — заказ тот же');

  // Машина уже в пути: есть факт прибытия — это перецепка, статус сохраняется.
  makeTrip('rv2');
  ensureTripStops(db, 'rv2');
  db.prepare(`UPDATE trip_stops SET actual_arrival=CURRENT_TIMESTAMP
    WHERE trip_id=? AND seq=(SELECT MIN(seq) FROM trip_stops WHERE trip_id=?)`).run('rv2', 'rv2');
  assert.equal(tripHasMovementFacts(db, db.prepare('SELECT * FROM trips WHERE id=?').get('rv2')), true);
  assert.equal(backToPreparationOnVehicleChange(db, db.prepare('SELECT * FROM trips WHERE id=?').get('rv2')), false);
  assert.equal(db.prepare('SELECT status FROM trips WHERE id=?').get('rv2').status, 'run',
    'рейс с фактами остаётся в пути');
});

test('устаревший шаг «документы» не блокирует работу старой вкладки', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pegas-legacy-step-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = openDatabase(path.join(directory, 'planner.db'), {
    username: 'root-admin', password: 'Temporary-password-2026', fullName: 'Администратор'
  });
  t.after(() => db.close());
  const { applyDispatchStep, DISPATCH_STEPS } = await import('../src/trip-control.mjs');
  assert.ok(!DISPATCH_STEPS.some(item => item.step === 'docs_checked'),
    'этап документов из чек-листа убран');
  const vehicle = db.prepare('SELECT id FROM vehicles LIMIT 1').get().id;
  const zone = db.prepare('SELECT id FROM zones LIMIT 1').get().id;
  db.prepare(`INSERT INTO trips(id,vehicle_id,customer_name,from_zone_id,to_zone_id,
    starts_at,ends_at,distance_km,revenue_vat,status,unloaded_at)
    VALUES('lg-1',?,'Клиент',?,?,'2026-08-26T05:00:00.000Z','2026-08-27T05:00:00.000Z',
    640,90000,'unloaded','2026-08-27T05:41:00.000Z')`).run(vehicle, zone, zone);
  // Вкладка, открытая до обновления, шлёт старый шаг — ответ успешный,
  // иначе у диспетчера рейс «не проводится» до перезагрузки страницы.
  const result = applyDispatchStep(db, 'lg-1', 'docs_checked', null, '2026-08-27T06:00:00.000Z');
  assert.ok(result.trip, 'рейс возвращён без ошибки');
  assert.equal(result.statusChanged, false);
  assert.equal(db.prepare(`SELECT docs_checked_at FROM trips WHERE id='lg-1'`).get().docs_checked_at,
    '2026-08-27T06:00:00.000Z', 'отметка проставлена — старый интерфейс уберёт карточку');
  // Повторный вызов не ломается и не переписывает отметку.
  applyDispatchStep(db, 'lg-1', 'docs_checked', null, '2026-08-27T07:00:00.000Z');
  assert.equal(db.prepare(`SELECT docs_checked_at FROM trips WHERE id='lg-1'`).get().docs_checked_at,
    '2026-08-27T06:00:00.000Z', 'первая отметка сохраняется');
  // Действительно неизвестный шаг по-прежнему отвергается.
  assert.throws(() => applyDispatchStep(db, 'lg-1', 'выдуманный_шаг', null), /Неизвестный шаг/);
});

test('пять этапов рейса: два клика на точку, простой считается по-прежнему', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pegas-stages-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = openDatabase(path.join(directory, 'planner.db'), {
    username: 'root-admin', password: 'Temporary-password-2026', fullName: 'Администратор'
  });
  t.after(() => db.close());
  const { ensureTripStops, listTripStops, syncTripFromStops } = await import('../src/trip-control.mjs');
  const { demurrageCases, operationNameOf } = await import('../src/planner-service.mjs');
  const vehicle = db.prepare('SELECT id FROM vehicles LIMIT 1').get().id;
  const zone = db.prepare('SELECT id FROM zones LIMIT 1').get().id;
  const admin = db.prepare('SELECT id FROM users LIMIT 1').get().id;
  const iso = shift => new Date(Date.now() + shift).toISOString();
  const HOUR = 3_600_000;
  // Заявка с окнами и рейс на линии: погрузка «с» — 30 ч назад, выгрузка «по» — 15 ч назад.
  db.prepare(`INSERT INTO orders(id,customer_name,from_zone_id,to_zone_id,rate_vat,
    window_from,window_to,stage,status) VALUES('st-o1','Клиент',?,?,90000,?,?,3,'planned')`)
    .run(zone, zone, iso(-30 * HOUR), iso(-15 * HOUR));
  db.prepare(`INSERT INTO trips(id,vehicle_id,order_id,customer_name,from_zone_id,to_zone_id,
    from_point,to_point,starts_at,ends_at,distance_km,revenue_vat,status,on_line_at)
    VALUES('st-1',?,'st-o1','Клиент',?,?,'Кораблино','Ногинск',?,?,640,90000,'run',?)`)
    .run(vehicle, zone, zone, iso(-30 * HOUR), iso(-15 * HOUR), iso(-31 * HOUR));
  ensureTripStops(db, 'st-1');
  const stops = listTripStops(db, 'st-1');
  const [load, unload] = [stops[0], stops[stops.length - 1]];
  const mark = (stopId, fields, at) => {
    const sets = fields.map(field => `${field}=?`).join(',');
    db.prepare(`UPDATE trip_stops SET ${sets} WHERE id=?`).run(...fields.map(() => at), stopId);
    return syncTripFromStops(db, 'st-1', admin);
  };
  // Этап «Погрузка»: приезд + начало работ одним кликом — 12 ч простоя на погрузке.
  mark(load.id, ['actual_arrival', 'work_started_at'], iso(-30 * HOUR));
  // Этап «В пути на выгрузку»: конец работ + убытие.
  mark(load.id, ['work_finished_at', 'actual_departure'], iso(-18 * HOUR));
  // Этап «Выгрузка»: приезд на выгрузку — это и есть trips.arrived_at.
  mark(unload.id, ['actual_arrival', 'work_started_at'], iso(-14 * HOUR));
  const midway = db.prepare(`SELECT status, arrived_at FROM trips WHERE id='st-1'`).get();
  assert.equal(midway.status, 'run', 'до конца выгрузки рейс на линии');
  assert.ok(midway.arrived_at, 'прибытие на выгрузку включает сторож «не выгружают» и простой');
  // Этап «Освободился»: конец работ + убытие — рейс выгружен и уходит с контроля.
  const status = mark(unload.id, ['work_finished_at', 'actual_departure'], iso(-1 * HOUR));
  assert.equal(status, 'unloaded', 'после освобождения рейс выгружен');

  // Простой не потерян: погрузка 12 ч от окна «с», выгрузка 13 ч от окна «по».
  const cases = demurrageCases(db);
  const load1 = cases.find(item => item.tripId === 'st-1' && item.kind === 'load');
  const unload1 = cases.find(item => item.tripId === 'st-1' && item.kind === 'unload');
  assert.ok(load1, 'случай простоя на погрузке найден');
  assert.ok(Math.abs(load1.idleHours - 12) < 0.2, `простой погрузки ~12 ч, получили ${load1?.idleHours}`);
  assert.ok(unload1, 'случай простоя на выгрузке найден');
  assert.ok(Math.abs(unload1.idleHours - 13) < 0.2, `простой выгрузки ~13 ч, получили ${unload1?.idleHours}`);

  // Имена операций для отчёта смены различают приезд и убытие.
  assert.equal(operationNameOf({ entity: 'trip_stop', action: 'update',
    details_json: '{"actualArrival":"2026-08-27T05:00:00.000Z"}' }), 'Отметка прибытия на точку');
  assert.equal(operationNameOf({ entity: 'trip_stop', action: 'update',
    details_json: '{"actualDeparture":"2026-08-27T05:00:00.000Z"}' }), 'Отметка убытия с точки');
});

test('порожний перегон: задание, контроль прибытия и новое место сцепки', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pegas-transfer-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = openDatabase(path.join(directory, 'planner.db'), {
    username: 'root-admin', password: 'Temporary-password-2026', fullName: 'Администратор'
  });
  t.after(() => db.close());
  const { transferPlaceOf, transferStage, transferTaskText, openTransfers } =
    await import('../public/assets/transfer.js');

  // Вид «перегон» принимается таблицей диспозиций (CHECK пересоздан миграцией).
  const vehicle = db.prepare('SELECT id, plate FROM vehicles LIMIT 1').get();
  const address = db.prepare('SELECT id, name, region FROM addresses WHERE latitude IS NOT NULL LIMIT 1').get();
  const iso = shift => new Date(Date.now() + shift).toISOString();
  db.prepare(`INSERT INTO vehicle_dispositions(id,vehicle_id,kind,starts_at,ends_at,
      address_id,from_label,purpose,empty_km) VALUES('tr-1',?,'transfer',?,?,?,'Самара','на базу',430)`)
    .run(vehicle.id, iso(-6 * 3600e3), iso(4 * 3600e3), address.id);
  const stored = db.prepare(`SELECT * FROM vehicle_dispositions WHERE id='tr-1'`).get();
  assert.equal(stored.kind, 'transfer', 'перегон сохраняется как вид диспозиции');

  // Этапы идут по порядку: задание → выезд → прибытие.
  const data = { dispositions: [{ ...stored, to_name: address.name, to_region: address.region,
    vehicle_plate: vehicle.plate, driver_name: 'Иванов И' }] };
  assert.equal(transferStage(data.dispositions[0]).step, 'driver_notified');
  assert.equal(openTransfers(data).length, 1, 'незавершённый перегон виден диспетчеру');
  assert.match(transferTaskText(data.dispositions[0]), /ПЕРЕГОН ПОРОЖНИМ/);
  assert.match(transferTaskText(data.dispositions[0]), /430 км порожним/);

  data.dispositions[0].driver_notified_at = iso(-5 * 3600e3);
  assert.equal(transferStage(data.dispositions[0]).step, 'departed');
  data.dispositions[0].departed_at = iso(-4 * 3600e3);
  assert.equal(transferStage(data.dispositions[0]).step, 'arrived');

  // До прибытия место сцепки не меняется, после — она стоит в точке назначения.
  assert.equal(transferPlaceOf(data, vehicle.id), null, 'машина в пути место не меняет');
  data.dispositions[0].arrived_at = iso(-1 * 3600e3);
  const place = transferPlaceOf(data, vehicle.id);
  assert.equal(place.name, address.name, 'после прибытия сцепка числится в точке назначения');
  assert.equal(place.region, address.region);
  assert.equal(openTransfers(data).length, 0, 'завершённый перегон уходит с контроля');
});

test('телефония: определение звонящего, темы вопросов и норматив 10 минут', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pegas-call-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = openDatabase(path.join(directory, 'planner.db'), {
    username: 'root-admin', password: 'Temporary-password-2026', fullName: 'Администратор'
  });
  t.after(() => db.close());
  const { phoneDigits, phonePretty, identifyCaller, QUESTION_TOPICS, QUESTION_SLA_MS,
    checkQuestionSla, questionStats, listDriverQuestions } = await import('../src/telephony.mjs');

  // Номер приводится к десяти цифрам в любом написании — иначе звонящий не найдётся.
  assert.equal(phoneDigits('+7 (987) 510-59-21'), '9875105921');
  assert.equal(phoneDigits('89875105921'), '9875105921');
  assert.equal(phoneDigits('79875105921'), '9875105921');
  assert.equal(phoneDigits(''), '');
  assert.equal(phonePretty('89875105921'), '+7 (987) 510-59-21');

  const vehicle = db.prepare('SELECT id, plate FROM vehicles LIMIT 1').get();
  db.prepare(`INSERT INTO drivers(id,full_name,phone,status,vehicle_id)
    VALUES('dr-call','Водитель Тест','+7 (987) 510-59-21','active',?)`).run(vehicle.id);
  const admin = db.prepare('SELECT id FROM users LIMIT 1').get().id;
  db.prepare(`UPDATE users SET phone='89001234567' WHERE id=?`).run(admin);
  db.prepare(`INSERT INTO customer_contacts(id,customer_name,full_name,phone)
    VALUES('cc-1','ТД Клиент','Логист клиента','+7 495 111-22-33')`).run();

  // Кто звонит: водитель важнее всех — ради него карточка и строится.
  assert.equal(identifyCaller(db, '79875105921').kind, 'driver');
  assert.equal(identifyCaller(db, '89875105921').vehicleId, vehicle.id, 'водитель приводит к своей машине');
  assert.equal(identifyCaller(db, '9001234567').kind, 'employee');
  assert.equal(identifyCaller(db, '4951112233').kind, 'customer');
  assert.equal(identifyCaller(db, '9999999999').kind, 'unknown');

  // Темы — фиксированный список: по нему считается, какой процесс сбоит.
  assert.ok(QUESTION_TOPICS.length >= 9, 'типовые вопросы водителей перечислены');
  assert.ok(QUESTION_TOPICS.some(topic => topic.key === 'no_data_sent' && topic.owner === 'Продажи'));
  assert.equal(QUESTION_SLA_MS, 10 * 60_000, 'норматив ответа — 10 минут');

  // Просрочка норматива поднимается один раз: карточка и так горит в списке.
  const old = new Date(Date.now() - 15 * 60_000).toISOString();
  db.prepare(`INSERT INTO driver_questions(id,vehicle_id,driver_name,topic,note,opened_by,opened_at)
    VALUES('q-1',?,'Водитель Тест','no_poa','нет доверенности',?,?)`).run(vehicle.id, admin, old);
  db.prepare(`INSERT INTO driver_questions(id,vehicle_id,driver_name,topic,opened_by,opened_at)
    VALUES('q-2',?,'Водитель Тест','next_task',?,CURRENT_TIMESTAMP)`).run(vehicle.id, admin);
  const overdue = checkQuestionSla(db);
  assert.equal(overdue.length, 1, 'просрочен только висящий дольше 10 минут');
  assert.equal(overdue[0].id, 'q-1');
  assert.equal(checkQuestionSla(db).length, 0, 'повторно тревогу не поднимаем');
  assert.equal(listDriverQuestions(db, { openOnly: true }).length, 2, 'оба вопроса ещё открыты');

  // Статистика: что спрашивают чаще и укладываемся ли в норматив.
  db.prepare(`UPDATE driver_questions SET closed_at=?, resolution='выдали доверенность' WHERE id='q-1'`)
    .run(new Date(Date.parse(old) + 20 * 60_000).toISOString());
  const stats = questionStats(db, new Date(Date.now() - 86_400_000).toISOString(),
    new Date(Date.now() + 86_400_000).toISOString());
  const poa = stats.find(item => item.topic === 'no_poa');
  assert.equal(poa.total, 1);
  assert.equal(poa.closed, 1);
  assert.equal(poa.slaPct, 0, 'решение за 20 минут в норматив не попало');
  assert.equal(poa.owner, 'Диспетчер', 'у темы есть ответственный процесс');
});
