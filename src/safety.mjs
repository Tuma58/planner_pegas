// «🛡 Безопасность движения» — рабочее место специалиста БДД (Штаб, 2 чел.
// по штату; чек-лист продукта 07.11.2026: у должности не было инструмента).
// Обязанности паспорта: допуски водителей, режим труда и отдыха, ДТП и
// нарушения ПДД (расследование, меры), инструктажи и стажировки.
// Журнал safety_events — одна запись = одно событие по водителю/машине;
// допуск и инструктаж имеют срок действия → «истекает» по порогу из
// Настроек (docsWarnDays — общий с карточкой ТС), без своей константы.
// Связи: медосмотр и техконтроль выпуска — экран «Выпуск» (П2), опоздания
// и акты — «Внештатки» (П4); здесь — то, что БДД решает сам.

import { randomUUID } from 'node:crypto';

export const SAFETY_KINDS = {
  dtp: 'ДТП', pdd: 'Нарушение ПДД / штраф', rto: 'Нарушение режима труда и отдыха',
  briefing: 'Инструктаж / стажировка', admission: 'Допуск водителя', other: 'Прочее'
};
const WITH_TERM = new Set(['briefing', 'admission']);

export function migrateSafety(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS safety_events (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('dtp','pdd','rto','briefing','admission','other')),
    driver_id TEXT, driver_name TEXT NOT NULL DEFAULT '', vehicle_id TEXT, plate TEXT NOT NULL DEFAULT '',
    happened_on TEXT NOT NULL, valid_until TEXT, description TEXT NOT NULL DEFAULT '', measures TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
    created_by_name TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    closed_at TEXT, closed_by_name TEXT NOT NULL DEFAULT '')`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_safety_driver ON safety_events(driver_id, happened_on)`);
}

export function addSafetyEvent(db, body, name) {
  if (!SAFETY_KINDS[body.kind]) return { ok: false, error: 'Вид события' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.happenedOn || ''))) return { ok: false, error: 'Дата события' };
  const driver = body.driverId ? db.prepare('SELECT id, full_name FROM drivers WHERE id=?').get(body.driverId) : null;
  if (body.driverId && !driver) return { ok: false, error: 'Водитель не найден' };
  const vehicle = body.vehicleId ? db.prepare('SELECT id, plate FROM vehicles WHERE id=?').get(body.vehicleId) : null;
  if (!driver && !vehicle) return { ok: false, error: 'Укажите водителя или машину' };
  if (WITH_TERM.has(body.kind) && !/^\d{4}-\d{2}-\d{2}$/.test(String(body.validUntil || ''))) {
    return { ok: false, error: 'Для допуска и инструктажа укажите срок действия' };
  }
  if (['dtp', 'pdd', 'rto'].includes(body.kind) && !String(body.description || '').trim()) {
    return { ok: false, error: 'Опишите, что произошло' };
  }
  const id = randomUUID();
  db.prepare(`INSERT INTO safety_events(id,kind,driver_id,driver_name,vehicle_id,plate,happened_on,valid_until,
      description,measures,status,created_by_name) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, body.kind, driver?.id || null, driver?.full_name || '', vehicle?.id || null, vehicle?.plate || '',
      body.happenedOn, WITH_TERM.has(body.kind) ? body.validUntil : null,
      String(body.description || '').trim(), String(body.measures || '').trim(),
      WITH_TERM.has(body.kind) ? 'closed' : 'open', name);
  return { ok: true, id };
}

// Закрыть событие (расследование завершено) — меры обязательны.
export function closeSafetyEvent(db, id, measures, name, at = new Date().toISOString()) {
  const row = db.prepare(`SELECT * FROM safety_events WHERE id=? AND status='open'`).get(id);
  if (!row) return { ok: false, error: 'Событие не найдено или уже закрыто' };
  const text = String(measures || '').trim() || row.measures;
  if (!text) return { ok: false, error: 'Укажите принятые меры' };
  db.prepare(`UPDATE safety_events SET status='closed', measures=?, closed_at=?, closed_by_name=? WHERE id=?`)
    .run(text, at, name, id);
  return { ok: true };
}

// Свод: открытые расследования, сроки допусков и инструктажей (последний
// по водителю и виду), водители без действующего допуска, события по
// водителям за период.
export function safetyBoard(db, { from, to, warnDays, nowMs = Date.now() }) {
  const today = new Date(nowMs + 3 * 3_600_000).toISOString().slice(0, 10);
  const warnTo = new Date(Date.parse(`${today}T00:00:00Z`) + warnDays * 864e5).toISOString().slice(0, 10);
  const events = db.prepare(`SELECT * FROM safety_events WHERE happened_on>=? AND happened_on<=? ORDER BY happened_on DESC`).all(from, to);
  const open = db.prepare(`SELECT * FROM safety_events WHERE status='open' ORDER BY happened_on`).all();
  const terms = db.prepare(`SELECT s.* FROM safety_events s
    WHERE s.kind IN ('briefing','admission') AND s.driver_id IS NOT NULL
      AND s.valid_until=(SELECT MAX(x.valid_until) FROM safety_events x WHERE x.driver_id=s.driver_id AND x.kind=s.kind)
    GROUP BY s.driver_id, s.kind`).all()
    .map(row => ({ ...row, termStatus: row.valid_until < today ? 'expired' : row.valid_until <= warnTo ? 'soon' : 'ok' }));
  const admitted = new Set(terms.filter(row => row.kind === 'admission' && row.termStatus !== 'expired').map(row => row.driver_id));
  const drivers = db.prepare(`SELECT id, full_name FROM drivers WHERE status<>'fired' ORDER BY full_name`).all();
  const byDriver = new Map();
  for (const event of events.filter(row => row.driver_id)) {
    const item = byDriver.get(event.driver_id) || { driverId: event.driver_id, name: event.driver_name, dtp: 0, pdd: 0, rto: 0 };
    if (item[event.kind] != null) item[event.kind] += 1;
    byDriver.set(event.driver_id, item);
  }
  return {
    from, to, warnDays, events, open,
    terms: terms.filter(row => row.termStatus !== 'ok').sort((a, b) => a.valid_until.localeCompare(b.valid_until)),
    withoutAdmission: drivers.filter(driver => !admitted.has(driver.id)).map(driver => ({ id: driver.id, name: driver.full_name })),
    byDriver: [...byDriver.values()].sort((a, b) => (b.dtp * 10 + b.rto * 3 + b.pdd) - (a.dtp * 10 + a.rto * 3 + a.pdd)),
    summary: { dtp: events.filter(row => row.kind === 'dtp').length, pdd: events.filter(row => row.kind === 'pdd').length,
      rto: events.filter(row => row.kind === 'rto').length, open: open.length,
      termsDue: terms.filter(row => row.termStatus !== 'ok').length, drivers: drivers.length }
  };
}
