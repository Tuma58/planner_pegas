// Разовое административное закрытие зависшего рейса т492ве58 (Митфуд
// №2710): план окончания 06.08, висел «в работе» месяц. Проставляет факт
// выгрузки текущим временем, переводит рейс в «Выгружен», двигает стадию
// заявки — та же механика, что кнопка смены статуса у диспетчера.
// Запуск (с Mac):
//   ssh root@91.144.178.239 'docker exec -i pegas-planner-planner-1 \
//     node --input-type=module - < /opt/pegas-planner/tools/close-trip-492.mjs'
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.env.DATABASE_PATH);
const TRIP = '8cf122d0-4ed9-4062-b9b7-3885d8811938';
const STOP = 'cf5549b6-c36e-496c-9d0e-61df892066cf';
db.exec('BEGIN');
try {
  const trip = db.prepare(`SELECT status, order_id FROM trips WHERE id=?`).get(TRIP);
  if (!trip) throw new Error('рейс не найден');
  if (trip.status !== 'run') throw new Error(`рейс уже в статусе ${trip.status} — закрывать нечего`);
  const now = new Date().toISOString();
  db.prepare(`UPDATE trip_stops SET actual_arrival=COALESCE(actual_arrival,?),
    work_started_at=COALESCE(work_started_at,?), work_finished_at=COALESCE(work_finished_at,?),
    actual_departure=COALESCE(actual_departure,?),
    note=TRIM(COALESCE(note,'')||' [закрыт административно: рейс висел с 06.08]'),
    updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(now, now, now, now, STOP);
  db.prepare(`UPDATE trips SET status='unloaded', arrived_at=COALESCE(arrived_at,?),
    unloaded_at=COALESCE(unloaded_at,CURRENT_TIMESTAMP), updated_at=CURRENT_TIMESTAMP
    WHERE id=?`).run(now, TRIP);
  if (trip.order_id) db.prepare(`UPDATE orders SET stage=4, status='planned',
    stage_changed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
    WHERE id=? AND stage<4`).run(trip.order_id);
  db.prepare(`INSERT INTO audit_log(id,user_id,action,entity,entity_id,details_json,ip)
    VALUES(lower(hex(randomblob(16))),NULL,'status','trip',?,?,'tools-script')`)
    .run(TRIP, JSON.stringify({ status: 'unloaded',
      note: 'административное закрытие по указанию руководителя: т492ве58 №2710 висел незакрытым с 06.08' }));
  db.exec('COMMIT');
  console.log('✓ рейс т492ве58 закрыт (Выгружен), факт выгрузки:', now);
} catch (error) { db.exec('ROLLBACK'); console.log('ОТКАТ:', error.message); }
