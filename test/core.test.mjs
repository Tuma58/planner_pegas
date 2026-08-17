import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { nextOrderNo, nextRouteNo, openDatabase, queueOutbox, settingsObject } from '../src/db.mjs';
import { hasPermission, permissionsFor } from '../src/permissions.mjs';
import { importTelematics, importTripsFrom1C, reportSnapshot, resolveZone, transitHours } from '../src/planner-service.mjs';
import { upsertPulled } from '../src/odata.mjs';
import { ipInSubnets, normalizeAllowedSubnets, parseCidr } from '../src/network-access.mjs';
import { decryptSecret, encryptSecret, hashPassword, verifyPassword } from '../src/security.mjs';
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
      { vehicle_id: 'V2', status: 'run', to_point: 'Пенза-склад', to_name: 'Дом',
        starts_at: '2026-08-19T08:00:00.000Z', ends_at: '2026-08-20T15:00:00.000Z' },
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
  const task = salesTaskFor(taskData, day);
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

  // Документы: у невыгруженного рейса шаг закрыт с понятной причиной...
  assert.throws(() => applyDispatchStep(db, 'td-1', 'docs_checked'), /после выгрузки/);
  // ...а выгруженному не нужен пройденный чек-лист подготовки: рейс мог
  // стать «выгружен» через факты стоянок, минуя «Контроль на линии».
  db.prepare(`INSERT INTO trips(id,vehicle_id,customer_name,from_zone_id,to_zone_id,
    starts_at,ends_at,distance_km,revenue_vat,status,unloaded_at)
    VALUES('td-2',?,'Клиент 2',?,?,'2026-08-10T06:00:00.000Z','2026-08-11T06:00:00.000Z',
    640,90000,'unloaded','2026-08-11T06:00:00.000Z')`)
    .run(db.prepare('SELECT id FROM vehicles LIMIT 1').get().id,
      db.prepare('SELECT id FROM zones ORDER BY sort_order LIMIT 1').get().id,
      db.prepare('SELECT id FROM zones ORDER BY sort_order LIMIT 1').get().id);
  applyDispatchStep(db, 'td-2', 'docs_checked');
  assert.ok(db.prepare(`SELECT docs_checked_at FROM trips WHERE id='td-2'`).get().docs_checked_at,
    'документы отмечены без пройденного чек-листа подготовки');

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
