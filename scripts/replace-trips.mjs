// Замена рейсов периода данными выгрузки 1С (JSON контракта v1.0 из xlsx-to-trips.py).
//
//   node scripts/replace-trips.mjs trips.json --from 2026-07-01 --to 2026-07-31 [--keep-customers]
//
// Удаляет рейсы, пересекающие период, импортирует новые через штатный importTripsFrom1C,
// затем обновляет карточки ТС (водитель, прицеп) и статистику заказчиков.
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { config } from '../src/config.mjs';
import { openDatabase } from '../src/db.mjs';
import { importTripsFrom1C } from '../src/planner-service.mjs';

const args = process.argv.slice(2);
const source = args.find(item => !item.startsWith('--'));
const option = name => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : null;
};
const dateFrom = option('from');
const dateTo = option('to');
const keepCustomers = args.includes('--keep-customers');

if (!source || !dateFrom || !dateTo) {
  console.error('Использование: node scripts/replace-trips.mjs <trips.json> --from YYYY-MM-DD --to YYYY-MM-DD');
  process.exit(2);
}

const rows = JSON.parse(fs.readFileSync(source, 'utf8'));
if (!Array.isArray(rows) || !rows.length) {
  console.error('Файл не содержит записей');
  process.exit(2);
}

const db = openDatabase(config.databasePath, config.admin, {
  initialAllowedSubnets: config.initialAllowedSubnets
});

// Действия выполняются от имени администратора: аудит и updated_by должны ссылаться на живого пользователя.
const actor = db.prepare(`SELECT id FROM users WHERE role='admin' AND active=1 ORDER BY created_at LIMIT 1`).get();
if (!actor) {
  console.error('Не найден активный администратор');
  process.exit(1);
}

const periodStart = `${dateFrom}T00:00:00.000Z`;
const periodEnd = `${dateTo}T23:59:59.999Z`;

// 1. Удаление рейсов, пересекающих период (заявки освобождаются, чтобы не остались висячие ссылки).
const doomed = db.prepare('SELECT id FROM trips WHERE starts_at<=? AND ends_at>=?').all(periodEnd, periodStart);
db.exec('BEGIN IMMEDIATE');
try {
  const releaseOrder = db.prepare(`UPDATE orders SET trip_id=NULL, assigned_vehicle_id=NULL,
    status='new', stage=1 WHERE trip_id=?`);
  const removeTrip = db.prepare('DELETE FROM trips WHERE id=?');
  for (const trip of doomed) {
    releaseOrder.run(trip.id);
    removeTrip.run(trip.id);
  }
  db.exec('COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  throw error;
}

// 2. Импорт новых рейсов штатным контрактом (распознавание геозон, поиск ТС, расчёт км).
const result = importTripsFrom1C(db, rows, actor);

// 3. Карточки ТС: ФИО водителя и прицеп по последнему рейсу каждого госномера.
const latestByTruck = new Map();
for (const row of rows) {
  const key = String(row.truck || '').toLocaleLowerCase('ru-RU');
  const current = latestByTruck.get(key);
  if (!current || Date.parse(row.depDate) > Date.parse(current.depDate)) latestByTruck.set(key, row);
}
let vehiclesUpdated = 0;
db.exec('BEGIN IMMEDIATE');
try {
  const updateVehicle = db.prepare(`UPDATE vehicles SET driver_name=?, trailer_plate=?,
    updated_at=CURRENT_TIMESTAMP WHERE plate=? COLLATE NOCASE`);
  for (const row of latestByTruck.values()) {
    if (!row.driver && !row.trailer) continue;
    vehiclesUpdated += updateVehicle.run(row.driver || '', row.trailer || '', row.truck).changes;
  }
  db.exec('COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  throw error;
}

// 4. Справочник заказчиков: статистика по фактическим рейсам периода.
let customersInserted = 0;
let customersUpdated = 0;
if (!keepCustomers) {
  const months = Math.max(1, (Date.parse(periodEnd) - Date.parse(periodStart)) / 86_400_000 / 30.44);
  const stats = db.prepare(`SELECT customer_name name, from_zone_id, to_zone_id,
      COUNT(*) trips, AVG(revenue_vat) average
    FROM trips WHERE starts_at<=? AND ends_at>=? AND customer_name<>''
    GROUP BY customer_name, from_zone_id, to_zone_id`).all(periodEnd, periodStart);
  db.exec('BEGIN IMMEDIATE');
  try {
    const find = db.prepare('SELECT id FROM customers WHERE name=? AND from_zone_id=? AND to_zone_id=?');
    const insert = db.prepare(`INSERT INTO customers(id,name,from_zone_id,to_zone_id,
      trip_count,average_rate_vat,trips_per_month) VALUES(?,?,?,?,?,?,?)`);
    const update = db.prepare(`UPDATE customers SET trip_count=?, average_rate_vat=?, trips_per_month=?
      WHERE id=?`);
    for (const row of stats) {
      const perMonth = Number((row.trips / months).toFixed(1));
      const average = Math.round(row.average);
      const existing = find.get(row.name, row.from_zone_id, row.to_zone_id);
      if (existing) {
        update.run(row.trips, average, perMonth, existing.id);
        customersUpdated += 1;
      } else {
        insert.run(randomUUID(), row.name, row.from_zone_id, row.to_zone_id, row.trips, average, perMonth);
        customersInserted += 1;
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

const totals = db.prepare(`SELECT COUNT(*) count, COALESCE(SUM(revenue_vat),0) revenue
  FROM trips WHERE starts_at<=? AND ends_at>=?`).get(periodEnd, periodStart);
db.close();

console.log(`Период ${dateFrom}…${dateTo}`);
console.log(`  удалено рейсов:      ${doomed.length}`);
console.log(`  импортировано:       ${result.imported}`);
console.log(`  обновлено:           ${result.updated}`);
console.log(`  пропущено с ошибкой: ${result.skipped}`);
console.log(`  карточек ТС обновлено: ${vehiclesUpdated}`);
if (!keepCustomers) console.log(`  заказчиков: добавлено ${customersInserted}, обновлено ${customersUpdated}`);
console.log(`  итого в периоде: ${totals.count} рейсов на ${Math.round(totals.revenue).toLocaleString('ru-RU')} ₽`);
if (result.errors.length) {
  console.log('\nОшибки (до 50):');
  for (const item of result.errors) console.log(`  ${item.id || '—'}: ${item.error}`);
}
