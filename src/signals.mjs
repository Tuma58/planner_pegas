// Сквозной контроль «мерим бдительность» (проект «Слияние», блок 4,
// решение руководителя 07.11.2026: случай открывает система, сигнал
// подаёт контролёр КНОПКОЙ). Журнал joint_signals — одна запись = один
// случай на стыке отделов («Рабочая среда СТ»: «починили — не
// укомплектовали», «укомплектовали — не загрузили»):
//   условие возникло (детектор) → «⚑ Сигнал» контролёра → «✓ Принято»
//   владельцем → закрыто само по факту (водитель назначен, рейс есть).
// KPI контролёра — доля сигналов вовремя и медиана «условие → сигнал»;
// KPI владельца — медиана «сигнал → устранено». «Вовремя» — цель из
// Настроек (signalTargetHours), выученная медиана видна рядом (дрейф).

import { randomUUID } from 'node:crypto';
import { JOINTS, idleVehicles } from './field.mjs';
import { toStatusAll } from './vehicle-card.mjs';

export function migrateSignals(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS joint_signals (
    id TEXT PRIMARY KEY, joint_key TEXT NOT NULL, vehicle_id TEXT NOT NULL, plate TEXT NOT NULL DEFAULT '',
    opened_at TEXT NOT NULL, signaled_at TEXT, signaled_by_name TEXT NOT NULL DEFAULT '',
    accepted_at TEXT, accepted_by_name TEXT NOT NULL DEFAULT '',
    closed_at TEXT, close_reason TEXT NOT NULL DEFAULT '')`);
  // Момент, когда система увидела случай: бдительность меряется от
  // max(возникло, увидено) — условия, висевшие до запуска детектора
  // (или до кнопки), не превращаются в «опоздание на месяцы».
  const cols = db.prepare(`PRAGMA table_info(joint_signals)`).all().map(col => col.name);
  if (!cols.includes('detected_at')) db.exec(`ALTER TABLE joint_signals ADD COLUMN detected_at TEXT`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_joint_signals_open ON joint_signals(joint_key, closed_at)`);
}

// Условия стыков сейчас: машина → время возникновения условия.
export function jointConditions(db, at = new Date().toISOString()) {
  const fromRepair = db.prepare(`SELECT d.vehicle_id, v.plate, d.starts_at,
      (SELECT MAX(r.released_at) FROM repair_orders r WHERE r.vehicle_id=d.vehicle_id
        AND r.status='released' AND r.released_at>=datetime(?, '-7 days')) released_at
    FROM vehicle_dispositions d JOIN vehicles v ON v.id=d.vehicle_id
    WHERE d.kind='no_driver' AND d.starts_at<=? AND d.ends_at>?`).all(at, at, at)
    .filter(row => row.released_at)
    .map(row => ({ vehicleId: row.vehicle_id, plate: row.plate,
      since: [row.released_at, row.starts_at].sort().pop() }));
  const lastEnd = db.prepare(`SELECT MAX(COALESCE(unloaded_at, ends_at)) e FROM trips
    WHERE vehicle_id=? AND status<>'rejected' AND ends_at<=?`);
  const idle = idleVehicles(db, at).map(row => {
    const id = db.prepare('SELECT id FROM vehicles WHERE plate=?').get(row.plate)?.id;
    return { vehicleId: id, plate: row.plate, since: (id && lastEnd.get(id, at)?.e) || at };
  }).filter(row => row.vehicleId);
  // Логистика → ТОиР: ТО по карточке машины «скоро» или «просрочено», а
  // заезда на ТО в Ремзону нет — логистика даёт окно (норма ТО — на каждой
  // машине вручную; без нормы машина сюда не попадает).
  const hasToOrder = db.prepare(`SELECT 1 FROM repair_orders WHERE vehicle_id=? AND purpose='ТО'
    AND status IN ('queued','in_progress','ready')`);
  let toDue = [];
  try {
    // ТО по пробегу или ТО ХОУ по моточасам — любое из двух «скоро/просрочено».
    const due = row => ['soon', 'overdue'].includes(row.status) || ['soon', 'overdue'].includes(row.hou?.status);
    toDue = toStatusAll(db).filter(row => due(row) && !hasToOrder.get(row.vehicleId))
      .map(row => ({ vehicleId: row.vehicleId, plate: row.plate, since: at }));
  } catch { toDue = []; }
  return { toir_drv: fromRepair, drv_log: idle, log_toir: toDue };
}

// Детектор (тик): открыть новые случаи, закрыть устранённые.
export function detectSignals(db, at = new Date().toISOString()) {
  const conditions = jointConditions(db, at);
  let opened = 0;
  let closed = 0;
  for (const [joint, rows] of Object.entries(conditions)) {
    const open = db.prepare(`SELECT id, vehicle_id FROM joint_signals WHERE joint_key=? AND closed_at IS NULL`).all(joint);
    const now = new Set(rows.map(row => row.vehicleId));
    for (const row of open) {
      if (now.has(row.vehicle_id)) continue;
      db.prepare(`UPDATE joint_signals SET closed_at=?, close_reason=? WHERE id=?`)
        .run(at, joint === 'toir_drv' ? 'водитель назначен' : joint === 'log_toir' ? 'ТО запланировано' : 'задание назначено', row.id);
      closed += 1;
    }
    const known = new Set(open.map(row => row.vehicle_id));
    for (const row of rows) {
      if (known.has(row.vehicleId)) continue;
      db.prepare(`INSERT INTO joint_signals(id,joint_key,vehicle_id,plate,opened_at,detected_at) VALUES(?,?,?,?,?,?)`)
        .run(randomUUID(), joint, row.vehicleId, row.plate, row.since, at);
      opened += 1;
    }
  }
  return { opened, closed };
}

const JOINT_BY_KEY = new Map(JOINTS.map(joint => [joint.key, joint]));

// Кто подаёт и кто принимает: контролёр — отдел «from», владелец — «to».
export function signalRights(access, joint) {
  const depts = access?.scope?.depts || [];
  return { canSignal: depts.includes(joint.from), canAccept: depts.includes(joint.to) };
}

export function openSignals(db, jointKey) {
  return db.prepare(`SELECT * FROM joint_signals WHERE joint_key=? AND closed_at IS NULL ORDER BY opened_at`).all(jointKey);
}

export function raiseSignal(db, id, userName, at = new Date().toISOString()) {
  const row = db.prepare('SELECT * FROM joint_signals WHERE id=?').get(id);
  if (!row) return { ok: false, status: 404, error: 'Случай не найден' };
  if (row.closed_at) return { ok: false, status: 422, error: 'Случай уже закрыт — устранено' };
  if (row.signaled_at) return { ok: false, status: 422, error: 'Сигнал уже подан' };
  db.prepare(`UPDATE joint_signals SET signaled_at=?, signaled_by_name=? WHERE id=?`).run(at, userName, id);
  return { ok: true, row: { ...row, signaled_at: at }, joint: JOINT_BY_KEY.get(row.joint_key) };
}

export function acceptSignal(db, id, userName, at = new Date().toISOString()) {
  const row = db.prepare('SELECT * FROM joint_signals WHERE id=?').get(id);
  if (!row) return { ok: false, status: 404, error: 'Случай не найден' };
  if (!row.signaled_at) return { ok: false, status: 422, error: 'Сигнала ещё не было' };
  if (row.accepted_at) return { ok: false, status: 422, error: 'Уже принято' };
  db.prepare(`UPDATE joint_signals SET accepted_at=?, accepted_by_name=? WHERE id=?`).run(at, userName, id);
  return { ok: true, row, joint: JOINT_BY_KEY.get(row.joint_key) };
}

const hours = (a, b) => (Date.parse(b) - Date.parse(a)) / 3.6e6;
const median = list => {
  if (!list.length) return null;
  const sorted = [...list].sort((x, y) => x - y);
  return +sorted[Math.floor(sorted.length / 2)].toFixed(1);
};

// KPI стыка за период: случаи, активные в периоде (увидены до конца,
// не закрыты до начала). Отсчёт — от max(возникло, увидено системой).
export function signalKpi(db, jointKey, from, to, targetH) {
  const rows = db.prepare(`SELECT * FROM joint_signals WHERE joint_key=?
      AND COALESCE(detected_at, opened_at)<? AND (closed_at IS NULL OR closed_at>=?)`)
    .all(jointKey, to, from);
  const startOf = row => [row.opened_at, row.detected_at || row.opened_at].sort().pop();
  const signaled = rows.filter(row => row.signaled_at);
  const toSignal = signaled.map(row => Math.max(0, hours(startOf(row), row.signaled_at)));
  const fixed = signaled.filter(row => row.closed_at).map(row => Math.max(0, hours(row.signaled_at, row.closed_at)));
  // Несигналенные случаи старше цели — тоже «не вовремя».
  const onTime = toSignal.filter(h => h <= targetH).length;
  return { cases: rows.length, signaled: signaled.length, accepted: rows.filter(row => row.accepted_at).length,
    onTimePct: rows.length ? Math.round(onTime / rows.length * 100) : null,
    signalMedianH: median(toSignal), fixMedianH: median(fixed), targetH };
}
