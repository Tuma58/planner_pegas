// «Выпуск» — единое место выпуска ТС на линию (процесс П2 «Рабочей среды
// СТ», проект «Слияние», решение руководителя 07.11.2026: «экран
// контролёр делаем»). Машины с выходом сегодня и завтра; по каждой —
// чек-лист из УЖЕ существующих отметок планера, своих статусов нет:
//   1 водитель закреплён (сцепка + нет «без водителя» на выходе),
//   2 путевой лист выдан, 3 предрейсовый медосмотр, 4 техконтроль
//   (отметки путевого листа; техконтроль — ещё и журнал release_checks),
//   5 задание водителю (шаг рейса), 6 выехал с базы (журнал КПП —
//   подсказка, не факт), 7 на линии (факт диспетчера).
// Техконтроль не пройден → «В ремонт»: заезд в Ремзону с дефектом
// (стык П2 → П1 «не допускать неисправный ТС»), уведомления ремзоне и
// эксплуатации. Отметка техконтроля пишется в путевой лист теми же
// колонками (tech_pre_at, tech_by), что и в карточке листа.

import { randomUUID } from 'node:crypto';
import { HANDOFFS } from './project160.mjs';

export function migrateRelease(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS release_checks (
    id TEXT PRIMARY KEY, vehicle_id TEXT NOT NULL, trip_id TEXT, transfer_id TEXT,
    result TEXT NOT NULL CHECK(result IN ('ok','fail')), defect TEXT NOT NULL DEFAULT '',
    checked_by TEXT NOT NULL DEFAULT '', checked_at TEXT NOT NULL, repair_order_id TEXT)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_release_checks_vehicle ON release_checks(vehicle_id, checked_at)`);
}

const MSK = 3 * 3_600_000;
const mskDayStart = (ms, plusDays = 0) => new Date(Math.floor((ms + MSK) / 864e5) * 864e5 - MSK + plusDays * 864e5).toISOString();

// Норматив подготовки выхода — регламент конвейера «задание водителю →
// вывод на линию» (проект «160 млн», HANDOFFS on_line), не новая цифра.
export const prepNormHours = () => HANDOFFS.find(item => item.key === 'on_line')?.normHours ?? null;

export const RELEASE_ITEMS = [
  ['driver', 'Водитель закреплён'], ['waybill', 'Путевой лист выдан'], ['med', 'Медосмотр'],
  ['tech', 'Техконтроль'], ['task', 'Задание водителю'], ['gate', 'Выехал с базы (КПП)'], ['line', 'На линии']
];

export function releaseBoard(db, nowMs = Date.now()) {
  const from = mskDayStart(nowMs);
  const to = mskDayStart(nowMs, 2);
  const trips = db.prepare(`SELECT t.id, t.vehicle_id, t.starts_at, t.order_no, t.driver_notified_at, t.on_line_at,
      t.status, v.plate, v.driver_name, v.trailer_plate, f.name from_name, z.name to_name
    FROM trips t JOIN vehicles v ON v.id=t.vehicle_id JOIN zones f ON f.id=t.from_zone_id JOIN zones z ON z.id=t.to_zone_id
    WHERE t.status IN ('plan','run') AND t.starts_at>=? AND t.starts_at<? ORDER BY t.starts_at`).all(from, to)
    .map(row => ({ ...row, kind: 'trip' }));
  const transfers = db.prepare(`SELECT d.id, d.vehicle_id, d.starts_at, d.departed_at, v.plate, v.driver_name,
      v.trailer_plate, a.name to_name FROM vehicle_dispositions d JOIN vehicles v ON v.id=d.vehicle_id
      LEFT JOIN addresses a ON a.id=d.address_id
    WHERE d.kind='transfer' AND d.starts_at>=? AND d.starts_at<? ORDER BY d.starts_at`).all(from, to)
    .map(row => ({ ...row, kind: 'transfer', from_name: 'перегон', on_line_at: row.departed_at, driver_notified_at: null }));
  const noDriver = db.prepare(`SELECT 1 FROM vehicle_dispositions WHERE vehicle_id=? AND kind='no_driver'
    AND starts_at<=? AND ends_at>?`);
  const waybillOf = db.prepare(`SELECT * FROM waybills WHERE (trip_id=? OR (trip_id IS NULL AND vehicle_id=?
    AND substr(starts_at,1,10)=substr(?,1,10))) ORDER BY created_at DESC LIMIT 1`);
  const checkOf = db.prepare(`SELECT * FROM release_checks WHERE vehicle_id=? AND checked_at>=?
    ORDER BY checked_at DESC LIMIT 1`);
  const gateOut = db.prepare(`SELECT exit_at FROM gate_log WHERE vehicle_id=? AND status='out'
    AND exit_at>=? ORDER BY exit_at LIMIT 1`);
  const prepH = prepNormHours();
  const items = [...trips, ...transfers].sort((a, b) => a.starts_at.localeCompare(b.starts_at)).map(row => {
    const waybill = waybillOf.get(row.kind === 'trip' ? row.id : '-', row.vehicle_id, row.starts_at);
    const dayStart = mskDayStart(Date.parse(row.starts_at));
    const check = checkOf.get(row.vehicle_id, dayStart);
    const checks = {
      driver: Boolean(row.driver_name) && !noDriver.get(row.vehicle_id, row.starts_at, row.starts_at),
      waybill: Boolean(waybill && waybill.status !== 'draft'),
      med: Boolean(waybill?.med_pre_at),
      tech: Boolean(waybill?.tech_pre_at || check?.result === 'ok'),
      task: row.kind === 'transfer' ? null : Boolean(row.driver_notified_at),
      gate: Boolean(gateOut.get(row.vehicle_id, dayStart)),
      line: Boolean(row.on_line_at)
    };
    const required = Object.entries(checks).filter(([key, value]) => value !== null && key !== 'gate');
    const missing = required.filter(([, value]) => !value).map(([key]) => key);
    const leftH = (Date.parse(row.starts_at) - nowMs) / 3.6e6;
    const tone = row.on_line_at ? 'ok' : missing.length === 0 ? 'ready'
      : leftH < 0 ? 'late' : prepH != null && leftH <= prepH ? 'risk' : 'wait';
    return { id: row.id, kind: row.kind, vehicleId: row.vehicle_id, plate: row.plate, driver: row.driver_name || '',
      trailer: row.trailer_plate || '', startsAt: row.starts_at, orderNo: row.order_no || '',
      route: `${row.from_name || ''} → ${row.to_name || ''}`, waybillId: waybill?.id || null,
      checks, missing, tone, leftH: +leftH.toFixed(1),
      lastCheck: check ? { result: check.result, defect: check.defect, by: check.checked_by, at: check.checked_at } : null };
  });
  const count = tone => items.filter(item => item.tone === tone).length;
  return { from, to, prepH, items,
    summary: { total: items.length, onLine: count('ok'), ready: count('ready'), risk: count('risk'), late: count('late'), wait: count('wait') } };
}

// Техконтроль пройден: журнал + отметка в путевой лист (если выдан).
export function techPass(db, { vehicleId, tripId = null, transferId = null, waybillId = null }, name, at = new Date().toISOString()) {
  if (!db.prepare('SELECT 1 FROM vehicles WHERE id=?').get(vehicleId)) return { ok: false, error: 'Машина не найдена' };
  db.prepare(`INSERT INTO release_checks(id,vehicle_id,trip_id,transfer_id,result,checked_by,checked_at)
    VALUES(?,?,?,?,'ok',?,?)`).run(randomUUID(), vehicleId, tripId, transferId, name, at);
  if (waybillId) {
    db.prepare(`UPDATE waybills SET tech_pre_at=?, tech_by=?, updated_at=CURRENT_TIMESTAMP
      WHERE id=? AND status<>'closed'`).run(at, name, waybillId);
  }
  return { ok: true };
}

// Техконтроль не пройден: журнал + заезд в Ремзону с дефектом (если у
// машины нет открытого заказ-наряда). Возвращает id заезда.
export function techFail(db, { vehicleId, tripId = null, transferId = null, defect }, name, odometerKm = null, at = new Date().toISOString()) {
  const text = String(defect || '').trim();
  if (!text) return { ok: false, error: 'Опишите неисправность' };
  if (!db.prepare('SELECT 1 FROM vehicles WHERE id=?').get(vehicleId)) return { ok: false, error: 'Машина не найдена' };
  const open = db.prepare(`SELECT id FROM repair_orders WHERE vehicle_id=? AND status IN ('queued','in_progress','ready')`).get(vehicleId);
  let orderId = open?.id || null;
  if (!orderId) {
    orderId = randomUUID();
    db.prepare(`INSERT INTO repair_orders(id,vehicle_id,purpose,complaint,odometer_km,arrived_at)
      VALUES(?,?,'прочее',?,?,datetime('now'))`).run(orderId, vehicleId, `Техконтроль выпуска: ${text} (${name})`, odometerKm);
  }
  db.prepare(`INSERT INTO release_checks(id,vehicle_id,trip_id,transfer_id,result,defect,checked_by,checked_at,repair_order_id)
    VALUES(?,?,?,?,'fail',?,?,?,?)`).run(randomUUID(), vehicleId, tripId, transferId, text, name, at, orderId);
  return { ok: true, repairOrderId: orderId, existed: Boolean(open) };
}
