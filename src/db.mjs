import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { hashPassword } from './security.mjs';
import { normalizeAllowedSubnets } from './network-access.mjs';
import { defaultSettings, distances, legacyZoneColors, vehicleTypes, zoneMetadata, zones } from './seed.mjs';

const tk20Data = JSON.parse(fs.readFileSync(new URL('./tk20-data.json', import.meta.url), 'utf8'));

const SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY, value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  full_name TEXT NOT NULL, email TEXT, password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','logist','resource','dispatcher','sales','accountant','manager')),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_by TEXT REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS zones (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, color TEXT NOT NULL, sort_order INTEGER NOT NULL,
  external_id TEXT UNIQUE, latitude REAL, longitude REAL
);
CREATE TABLE IF NOT EXISTS zone_aliases (
  id TEXT PRIMARY KEY, zone_id TEXT NOT NULL REFERENCES zones(id) ON DELETE CASCADE,
  alias TEXT NOT NULL UNIQUE COLLATE NOCASE
);
CREATE TABLE IF NOT EXISTS vehicle_types (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, external_id TEXT UNIQUE
);
CREATE TABLE IF NOT EXISTS route_rates (
  id TEXT PRIMARY KEY, from_zone_id TEXT NOT NULL REFERENCES zones(id),
  to_zone_id TEXT NOT NULL REFERENCES zones(id), distance_km REAL NOT NULL,
  default_rate_vat REAL NOT NULL, UNIQUE(from_zone_id,to_zone_id)
);
CREATE TABLE IF NOT EXISTS vehicles (
  id TEXT PRIMARY KEY, plate TEXT NOT NULL UNIQUE COLLATE NOCASE, trailer_plate TEXT,
  type_id TEXT NOT NULL REFERENCES vehicle_types(id), driver_name TEXT,
  zone_id TEXT REFERENCES zones(id), status TEXT NOT NULL DEFAULT 'work'
    CHECK(status IN ('work','repair','no_driver','out')),
  unavailable_from TEXT, unavailable_to TEXT, external_id TEXT UNIQUE, external_etag TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, from_zone_id TEXT REFERENCES zones(id),
  to_zone_id TEXT REFERENCES zones(id), trip_count INTEGER NOT NULL DEFAULT 0,
  average_rate_vat REAL NOT NULL DEFAULT 0, trips_per_month REAL NOT NULL DEFAULT 0,
  external_id TEXT UNIQUE, external_etag TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(name,from_zone_id,to_zone_id)
);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY, customer_id TEXT REFERENCES customers(id), customer_name TEXT NOT NULL,
  from_zone_id TEXT NOT NULL REFERENCES zones(id), to_zone_id TEXT NOT NULL REFERENCES zones(id),
  rate_vat REAL NOT NULL, window_from TEXT NOT NULL, window_to TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','planned','cancelled')),
  temperature_mode TEXT NOT NULL DEFAULT '', body_type TEXT NOT NULL DEFAULT '',
  stage INTEGER NOT NULL DEFAULT 0 CHECK(stage BETWEEN 0 AND 5),
  assigned_vehicle_id TEXT REFERENCES vehicles(id), trip_id TEXT REFERENCES trips(id),
  external_id TEXT UNIQUE, external_etag TEXT, created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS trips (
  id TEXT PRIMARY KEY, vehicle_id TEXT NOT NULL REFERENCES vehicles(id),
  order_id TEXT REFERENCES orders(id), customer_name TEXT NOT NULL DEFAULT '',
  from_zone_id TEXT NOT NULL REFERENCES zones(id), to_zone_id TEXT NOT NULL REFERENCES zones(id),
  starts_at TEXT NOT NULL, ends_at TEXT NOT NULL, distance_km REAL NOT NULL,
  revenue_vat REAL NOT NULL, status TEXT NOT NULL DEFAULT 'plan'
    CHECK(status IN ('plan','run','unloaded','done','paid','rejected')),
  rejection_reason TEXT, external_id TEXT UNIQUE, external_etag TEXT,
  temperature_mode TEXT NOT NULL DEFAULT '', body_type TEXT NOT NULL DEFAULT '',
  actual_distance_km REAL, unloaded_at TEXT, source_system TEXT NOT NULL DEFAULT 'planner',
  created_by TEXT REFERENCES users(id), updated_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_trips_period ON trips(starts_at,ends_at);
CREATE INDEX IF NOT EXISTS idx_trips_vehicle ON trips(vehicle_id);
CREATE TABLE IF NOT EXISTS vehicle_dispositions (
  id TEXT PRIMARY KEY, vehicle_id TEXT NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('work','repair','no_driver','shift','out')),
  starts_at TEXT NOT NULL, ends_at TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
  created_by TEXT REFERENCES users(id), updated_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK(ends_at>starts_at)
);
CREATE INDEX IF NOT EXISTS idx_vehicle_dispositions_period
  ON vehicle_dispositions(vehicle_id,starts_at,ends_at);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  author_id TEXT REFERENCES users(id), author_name TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'user' CHECK(kind IN ('user','auto')),
  text TEXT NOT NULL, target_role TEXT, entity TEXT, entity_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS trip_stops (
  id TEXT PRIMARY KEY, trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL, kind TEXT NOT NULL DEFAULT 'D' CHECK(kind IN ('P','D')),
  point TEXT NOT NULL DEFAULT '',
  planned_arrival TEXT, planned_departure TEXT,
  actual_arrival TEXT, actual_departure TEXT,
  work_started_at TEXT, work_finished_at TEXT,
  distance_km REAL NOT NULL DEFAULT 0, note TEXT NOT NULL DEFAULT '',
  updated_by TEXT REFERENCES users(id), updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_trip_stops_trip ON trip_stops(trip_id,seq);
CREATE TABLE IF NOT EXISTS revenue_plans (
  period_start TEXT PRIMARY KEY, target_net REAL NOT NULL DEFAULT 0,
  updated_by TEXT REFERENCES users(id), updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS period_snapshots (
  id TEXT PRIMARY KEY, period_start TEXT NOT NULL UNIQUE, period_end TEXT NOT NULL,
  label TEXT NOT NULL, metrics_json TEXT NOT NULL, closed_by TEXT REFERENCES users(id),
  closed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS integration_connectors (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL DEFAULT '',
  token_cipher TEXT, enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  config_json TEXT NOT NULL DEFAULT '{}', last_success_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  theme TEXT NOT NULL DEFAULT 'light' CHECK(theme IN ('light','dark','system')),
  preferences_json TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS integration_config (
  id INTEGER PRIMARY KEY CHECK(id=1), base_url TEXT NOT NULL DEFAULT '', username TEXT NOT NULL DEFAULT '',
  password_cipher TEXT, enabled INTEGER NOT NULL DEFAULT 0, pull_interval_min INTEGER NOT NULL DEFAULT 30,
  write_enabled INTEGER NOT NULL DEFAULT 0, write_policy TEXT NOT NULL DEFAULT 'manual'
    CHECK(write_policy IN ('manual','automatic')), verify_tls INTEGER NOT NULL DEFAULT 1,
  last_success_at TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS integration_mappings (
  entity TEXT PRIMARY KEY, entity_set TEXT NOT NULL, direction TEXT NOT NULL DEFAULT 'pull',
  field_map_json TEXT NOT NULL, filter_query TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sync_cursors (
  entity TEXT PRIMARY KEY, cursor_value TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sync_jobs (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL,
  finished_at TEXT, pulled INTEGER NOT NULL DEFAULT 0, pushed INTEGER NOT NULL DEFAULT 0,
  error_text TEXT, details_json TEXT NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_running_sync_job
  ON sync_jobs((1)) WHERE status='running';
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY, entity TEXT NOT NULL, entity_id TEXT NOT NULL, operation TEXT NOT NULL,
  payload_json TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'pending_approval'
    CHECK(status IN ('pending_approval','approved','processing','sent','failed','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT, last_error TEXT,
  approved_by TEXT REFERENCES users(id), approved_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), action TEXT NOT NULL,
  entity TEXT NOT NULL, entity_id TEXT, details_json TEXT NOT NULL DEFAULT '{}',
  ip TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT OR IGNORE INTO integration_config(id) VALUES(1);
INSERT OR IGNORE INTO integration_connectors(id,name) VALUES('telematics','Телематика / мониторинг');
`;

const asJson = value => JSON.stringify(value);

export function openDatabase(databasePath, admin, options = {}) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  migrateColumns(db);
  seed(db, admin, options);
  return db;
}

function migrateColumns(db) {
  const ensure = (table, column, definition) => {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some(item => item.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  };
  ensure('zones', 'latitude', 'REAL');
  ensure('zones', 'longitude', 'REAL');
  ensure('customers', 'trips_per_month', 'REAL NOT NULL DEFAULT 0');
  ensure('orders', 'temperature_mode', "TEXT NOT NULL DEFAULT ''");
  ensure('orders', 'body_type', "TEXT NOT NULL DEFAULT ''");
  ensure('orders', 'stage', 'INTEGER NOT NULL DEFAULT 0');
  ensure('orders', 'assigned_vehicle_id', 'TEXT REFERENCES vehicles(id)');
  ensure('orders', 'trip_id', 'TEXT REFERENCES trips(id)');
  ensure('trips', 'temperature_mode', "TEXT NOT NULL DEFAULT ''");
  ensure('trips', 'body_type', "TEXT NOT NULL DEFAULT ''");
  ensure('trips', 'actual_distance_km', 'REAL');
  ensure('trips', 'unloaded_at', 'TEXT');
  ensure('trips', 'source_system', "TEXT NOT NULL DEFAULT 'planner'");
  // Пункты погрузки/выгрузки: маршрут показывается «из пункта в пункт»
  // (Пенза → Видное), геозоны остаются каркасом ставок, экономики и карты.
  ensure('orders', 'from_point', "TEXT NOT NULL DEFAULT ''");
  ensure('orders', 'to_point', "TEXT NOT NULL DEFAULT ''");
  ensure('trips', 'from_point', "TEXT NOT NULL DEFAULT ''");
  ensure('trips', 'to_point', "TEXT NOT NULL DEFAULT ''");
  // Жизненный цикл заявки: причина отклонения либо возврата из плана и момент возврата.
  // Отклонённая заявка = status 'cancelled' с заполненной причиной; вернувшаяся из плана —
  // снова 'new', но с непустым returned_at, чтобы продажи видели историю.
  ensure('orders', 'rejection_reason', 'TEXT');
  ensure('orders', 'returned_at', 'TEXT');
  // Конвейер: момент входа в текущую стадию (видно, сколько заявка ждёт действия)
  // и подтверждение продажами — для реестра в отчёте руководителя.
  ensure('orders', 'stage_changed_at', 'TEXT');
  ensure('orders', 'confirmed_at', 'TEXT');
  // Шаги диспетчеризации рейса: подтверждение назначения логистом, затем
  // чек-лист диспетчера — заказ внесён в учётную систему (1С ведётся отдельно),
  // задание водителю отправлено, рейс на контроле на линии.
  // Мягкое удаление отклонённой заявки: уходит из оперативных списков,
  // но остаётся в БД для аналитики (реестр отклонённых в отчёте).
  ensure('orders', 'deleted_at', 'TEXT');
  // Инвариант реестра отклонённых: у каждой отклонённой заявки есть причина.
  // Новые пути отклонения требуют её обязательно (сервер вернёт 422);
  // записи, созданные до этого правила, получают явную пометку.
  db.exec(`UPDATE orders SET rejection_reason='Причина не указана'
    WHERE status='cancelled' AND (rejection_reason IS NULL OR rejection_reason='')`);
  ensure('trips', 'logist_confirmed_at', 'TEXT');
  ensure('trips', 'entered_1c_at', 'TEXT');
  ensure('trips', 'driver_notified_at', 'TEXT');
  ensure('trips', 'on_line_at', 'TEXT');
  // Отметка «продажи уведомлены об опоздании» — чтобы диспетчер видел,
  // что клиенту уже сообщили о переносе прибытия.
  ensure('trips', 'delay_notified_at', 'TEXT');
  // Факт прибытия под выгрузку (отмечает диспетчер): до него затянувшийся
  // рейс — «опоздание в пути», после — отсчёт выгрузки и простоя.
  ensure('trips', 'arrived_at', 'TEXT');
  // «ТС не выгружают»: момент первого алерта (продажам и логистам),
  // момент последнего ежечасного пинга диспетчерам и выставленный
  // клиенту простой (входит в выручку рейса).
  ensure('trips', 'unload_alert_at', 'TEXT');
  ensure('trips', 'unload_ping_at', 'TEXT');
  ensure('trips', 'demurrage_vat', 'REAL NOT NULL DEFAULT 0');
  // Бэкфилл истории: рейсы, созданные до появления диспетчеризации, пришли из
  // 1С (внесены и подтверждены по определению); идущие и завершённые уже
  // на линии. Однократно, чтобы не завалить логиста и диспетчера прошлым.
  if (!db.prepare(`SELECT 1 FROM app_meta WHERE key='dispatch_backfill_v1'`).get()) {
    db.exec(`UPDATE trips SET
        logist_confirmed_at=COALESCE(logist_confirmed_at,created_at),
        entered_1c_at=COALESCE(entered_1c_at,created_at)
      WHERE status<>'rejected';
      UPDATE trips SET
        driver_notified_at=COALESCE(driver_notified_at,created_at),
        on_line_at=COALESCE(on_line_at,created_at)
      WHERE status IN ('run','unloaded','done','paid');`);
    db.prepare(`INSERT OR IGNORE INTO app_meta(key,value) VALUES('dispatch_backfill_v1','1')`).run();
  }
  // Мульти-роли: JSON-массив; колонка role остаётся основной ролью (roles[0]).
  ensure('users', 'roles', 'TEXT');
  db.exec(`UPDATE users SET roles=json_array(role) WHERE roles IS NULL`);
  // Диспозиция «В работе»: план загрузки ТС. SQLite не меняет CHECK через
  // ALTER — существующая таблица пересоздаётся с расширенным списком видов.
  const dispositionsSql = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='vehicle_dispositions'`).get()?.sql || '';
  if (dispositionsSql && !dispositionsSql.includes("'work'")) {
    db.exec(`BEGIN IMMEDIATE;
      ALTER TABLE vehicle_dispositions RENAME TO vehicle_dispositions_legacy;
      CREATE TABLE vehicle_dispositions (
        id TEXT PRIMARY KEY, vehicle_id TEXT NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('work','repair','no_driver','shift','out')),
        starts_at TEXT NOT NULL, ends_at TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
        created_by TEXT REFERENCES users(id), updated_by TEXT REFERENCES users(id),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK(ends_at>starts_at)
      );
      INSERT INTO vehicle_dispositions SELECT * FROM vehicle_dispositions_legacy;
      DROP TABLE vehicle_dispositions_legacy;
      CREATE INDEX IF NOT EXISTS idx_vehicle_dispositions_period
        ON vehicle_dispositions(vehicle_id,starts_at,ends_at);
      COMMIT;`);
  }
}

function seed(db, admin, options) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const putSetting = db.prepare('INSERT OR IGNORE INTO settings(key,value_json) VALUES(?,?)');
    for (const [key, value] of Object.entries(defaultSettings)) putSetting.run(key, asJson(value));
    if (options.initialAllowedSubnets?.length &&
        !db.prepare(`SELECT 1 FROM app_meta WHERE key='network_access_initialized'`).get()) {
      const allowedSubnets = normalizeAllowedSubnets(options.initialAllowedSubnets);
      db.prepare(`UPDATE settings SET value_json=?,updated_at=CURRENT_TIMESTAMP WHERE key='networkAccess'`)
        .run(asJson({ allowedSubnets }));
      db.prepare(`INSERT INTO app_meta(key,value) VALUES('network_access_initialized','1')`).run();
    }

    const putZone = db.prepare('INSERT OR IGNORE INTO zones(id,name,color,sort_order) VALUES(?,?,?,?)');
    zones.forEach(([name, color], index) => putZone.run(randomUUID(), name, color, index));

    // Миграция палитры зон (v22): заменяем только прежние дефолтные цвета любого
    // поколения, изменённые администратором значения не трогаем. Идемпотентно по app_meta.
    if (!db.prepare(`SELECT 1 FROM app_meta WHERE key='zone_palette_v22'`).get()) {
      const updateColor = db.prepare('UPDATE zones SET color=? WHERE name=? AND color=?');
      zones.forEach(([name, color]) => {
        for (const legacy of legacyZoneColors[name] || []) updateColor.run(color, name, legacy);
      });
      db.prepare(`INSERT OR IGNORE INTO app_meta(key,value) VALUES('zone_palette_v22','1')`).run();
    }

    const putType = db.prepare('INSERT OR IGNORE INTO vehicle_types(id,name) VALUES(?,?)');
    vehicleTypes.forEach(name => putType.run(randomUUID(), name));

    const zoneId = name => db.prepare('SELECT id FROM zones WHERE name=?').get(name).id;
    const typeId = name => db.prepare('SELECT id FROM vehicle_types WHERE name=?').get(name).id;

    // Координаты и алиасы геозон обновляются при каждом открытии БД, а не только при первом
    // засеве: справочник городов пополняется по мере новых выгрузок 1С и должен доезжать
    // до уже работающих установок. INSERT OR IGNORE не трогает добавленные администратором.
    const updateZoneGeo = db.prepare('UPDATE zones SET latitude=?,longitude=? WHERE id=?');
    const putAlias = db.prepare('INSERT OR IGNORE INTO zone_aliases(id,zone_id,alias) VALUES(?,?,?)');
    for (const [name, metadata] of Object.entries(zoneMetadata)) {
      const id = zoneId(name);
      updateZoneGeo.run(metadata.latitude, metadata.longitude, id);
      metadata.aliases.forEach(alias => putAlias.run(randomUUID(), id, alias));
    }

    const putRate = db.prepare(`
      INSERT OR IGNORE INTO route_rates(id,from_zone_id,to_zone_id,distance_km,default_rate_vat)
      VALUES(?,?,?,?,?)`);
    distances.forEach(([from, to, km, rate]) =>
      putRate.run(randomUUID(), zoneId(from), zoneId(to), km, rate));

    if (!db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
      db.prepare(`
        INSERT INTO users(id,username,full_name,password_hash,role,roles)
        VALUES(?,?,?,?, 'admin', '["admin"]')`
      ).run(randomUUID(), admin.username, admin.fullName, hashPassword(admin.password));
    }
    applyTk20Seed(db, zoneId, typeId);

    const mappings = [
      ['vehicles', 'Catalog_ТранспортныеСредства', 'pull',
        { externalId: 'Ref_Key', plate: 'Description', driverName: 'Водитель', trailerPlate: 'Прицеп' }],
      ['customers', 'Catalog_Контрагенты', 'pull',
        { externalId: 'Ref_Key', name: 'Description' }],
      ['orders', 'Document_ЗаявкаНаПеревозку', 'both',
        { externalId: 'Ref_Key', customerName: 'Контрагент_Description', fromZone: 'ЗонаОтправления',
          toZone: 'ЗонаНазначения', rateVat: 'Сумма', windowFrom: 'ДатаПогрузки',
          windowTo: 'ДатаДоставки', status: 'Статус', temperatureMode: 'ТемпературныйРежим',
          bodyType: 'ТипКузова', idempotencyKey: 'IntegrationKey' }],
      ['trips', 'Document_Рейс', 'both',
        { externalId: 'Ref_Key', vehicle: 'ТранспортноеСредство_Key',
          customerName: 'Контрагент_Description', fromZone: 'ЗонаОтправления',
          toZone: 'ЗонаНазначения', startsAt: 'ДатаНачала', endsAt: 'ДатаОкончания',
          distanceKm: 'Расстояние', revenueVat: 'Сумма', status: 'Статус',
          temperatureMode: 'ТемпературныйРежим', bodyType: 'ТипКузова',
          idempotencyKey: 'IntegrationKey' }]
    ];
    const putMapping = db.prepare(`
      INSERT OR IGNORE INTO integration_mappings(entity,entity_set,direction,field_map_json)
      VALUES(?,?,?,?)`);
    mappings.forEach(row => putMapping.run(row[0], row[1], row[2], asJson(row[3])));
    if (db.prepare(`SELECT value FROM app_meta WHERE key='odata_mapping_version'`).get()?.value !== '2') {
      const updateMapping = db.prepare(`UPDATE integration_mappings
        SET entity_set=?,direction=?,field_map_json=?,updated_at=CURRENT_TIMESTAMP WHERE entity=?`);
      for (const row of mappings) updateMapping.run(row[1], row[2], asJson(row[3]), row[0]);
      db.prepare(`INSERT INTO app_meta(key,value) VALUES('odata_mapping_version','2')
        ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run();
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function applyTk20Seed(db, zoneId, typeId) {
  if (db.prepare(`SELECT 1 FROM app_meta WHERE key='tk20_seed_version' AND value=?`).get(String(tk20Data.version))) {
    return;
  }

  const general = { ...defaultSettings.general, horizonStart: tk20Data.horizonStart };
  const updateSetting = db.prepare(`INSERT INTO settings(key,value_json,updated_at)
    VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET
    value_json=excluded.value_json,updated_at=CURRENT_TIMESTAMP`);
  updateSetting.run('general', asJson(general));
  updateSetting.run('calculation', asJson(defaultSettings.calculation));
  updateSetting.run('orderOptions', asJson(defaultSettings.orderOptions));

  const legacyTrips = db.prepare(`SELECT COUNT(*) count FROM trips
    WHERE external_id IS NULL AND starts_at>='2026-08-01' AND starts_at<'2026-09-01'`).get().count;
  const totalTrips = db.prepare('SELECT COUNT(*) count FROM trips').get().count;
  if (totalTrips === 12 && legacyTrips === 12) db.prepare('DELETE FROM trips').run();

  const putVehicleCompatible = db.prepare(`INSERT INTO vehicles(
      id,plate,type_id,driver_name,trailer_plate,zone_id,status)
    VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(plate) DO UPDATE SET type_id=excluded.type_id,driver_name=excluded.driver_name,
      trailer_plate=excluded.trailer_plate,updated_at=CURRENT_TIMESTAMP`);
  for (const vehicle of tk20Data.vehicles) {
    putVehicleCompatible.run(
      randomUUID(), vehicle.p, typeId(vehicle.t), vehicle.d || '', vehicle.trailer || '',
      zoneId(vehicle.zone || 'Дом'), normalizeVehicleStatus(vehicle.status));
  }

  const incomingPlates = new Set(tk20Data.vehicles.map(vehicle => vehicle.p.toLocaleLowerCase('ru-RU')));
  if (totalTrips === 12 && legacyTrips === 12) {
    for (const vehicle of db.prepare('SELECT id,plate FROM vehicles').all()) {
      if (!incomingPlates.has(vehicle.plate.toLocaleLowerCase('ru-RU')) &&
          !db.prepare('SELECT 1 FROM trips WHERE vehicle_id=? LIMIT 1').get(vehicle.id)) {
        db.prepare('DELETE FROM vehicles WHERE id=?').run(vehicle.id);
      }
    }
  }

  const findCustomer = db.prepare(`SELECT id FROM customers
    WHERE name=? AND from_zone_id=? AND to_zone_id=? LIMIT 1`);
  const putCustomer = db.prepare(`INSERT INTO customers(
    id,name,from_zone_id,to_zone_id,trip_count,average_rate_vat,trips_per_month)
    VALUES(?,?,?,?,?,?,?)`);
  const updateCustomer = db.prepare(`UPDATE customers SET trip_count=?,average_rate_vat=?,
    trips_per_month=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`);
  for (const [name, from, to, count, rate, tripsPerMonth] of tk20Data.customers) {
    const fromId = zoneId(from);
    const toId = zoneId(to);
    const current = findCustomer.get(name, fromId, toId);
    if (current) updateCustomer.run(count || 0, rate || 0, tripsPerMonth || 0, current.id);
    else putCustomer.run(randomUUID(), name, fromId, toId, count || 0, rate || 0, tripsPerMonth || 0);
  }

  const adminId = db.prepare('SELECT id FROM users ORDER BY created_at LIMIT 1').get().id;
  const findVehicle = db.prepare('SELECT id FROM vehicles WHERE plate=? COLLATE NOCASE');
  const putTrip = db.prepare(`INSERT INTO trips(
    id,vehicle_id,customer_name,from_zone_id,to_zone_id,starts_at,ends_at,
    distance_km,revenue_vat,status,external_id,source_system,created_by,updated_by)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(external_id) DO NOTHING`);
  const horizon = Date.parse(`${tk20Data.horizonStart}T00:00:00.000Z`);
  tk20Data.trips.forEach((row, index) => {
    const [plate, from, to, startDay, durationDays, distance, revenue, customer, status] = row;
    const startsAt = new Date(horizon + Number(startDay) * 86_400_000).toISOString();
    const endsAt = new Date(horizon + (Number(startDay) + Number(durationDays)) * 86_400_000).toISOString();
    putTrip.run(
      randomUUID(), findVehicle.get(plate).id, customer || '', zoneId(from), zoneId(to),
      startsAt, endsAt, Number(distance || 0), Number(revenue || 0), normalizeTripStatus(status),
      `html-tk20:J${index}`, 'html-tk20', adminId, adminId);
  });

  db.prepare(`INSERT INTO app_meta(key,value) VALUES('tk20_seed_version',?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(String(tk20Data.version));
  db.prepare(`INSERT INTO app_meta(key,value) VALUES('tk20_source_sha256',?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(tk20Data.sourceSha256);
}

function normalizeTripStatus(status) {
  return ({ unl: 'unloaded', pay: 'paid', rej: 'rejected' })[status] || status || 'plan';
}

function normalizeVehicleStatus(status) {
  return ({ rep: 'repair', nodrv: 'no_driver' })[status] || status || 'work';
}

export function settingsObject(db) {
  return Object.fromEntries(db.prepare('SELECT key,value_json FROM settings').all()
    .map(row => [row.key, JSON.parse(row.value_json)]));
}

export function audit(db, user, action, entity, entityId, details = {}, ip = '') {
  db.prepare(`INSERT INTO audit_log(id,user_id,action,entity,entity_id,details_json,ip)
    VALUES(?,?,?,?,?,?,?)`).run(
    randomUUID(), user?.id || null, action, entity, entityId || null, asJson(details), ip);
}

export function queueOutbox(db, entity, entityId, operation, payload, automatic = false) {
  const existing = db.prepare(`SELECT * FROM outbox
    WHERE entity=? AND entity_id=? AND status IN ('pending_approval','approved')
    ORDER BY created_at DESC LIMIT 1`).get(entity, entityId);
  if (existing) {
    if (existing.operation === 'create' && operation === 'delete') {
      db.prepare(`UPDATE outbox SET status='cancelled',last_error='Локальное создание отменено до отправки',
        updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(existing.id);
      return existing.id;
    }
    const effectiveOperation = existing.operation === 'create' ? 'create' : operation;
    db.prepare(`UPDATE outbox SET operation=?,payload_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(effectiveOperation, asJson(payload), existing.id);
    return existing.id;
  }
  const id = randomUUID();
  db.prepare(`INSERT INTO outbox(
    id,entity,entity_id,operation,payload_json,idempotency_key,status)
    VALUES(?,?,?,?,?,?,?)`).run(
    id, entity, entityId, operation, asJson(payload),
    `${entity}:${entityId}:${operation}:${Date.now()}`, automatic ? 'approved' : 'pending_approval');
  return id;
}
