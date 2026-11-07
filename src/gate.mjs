// Журнал КПП стоянки базы в Пензе — рабочее место «Охранник-парковщик»
// (проект «Слияние», решения руководителя 07.11.2026). Перенесено
// устройство разработки «Журнал КПП ведомственной стоянки» (Google Apps
// Script): одна кнопка на номер — машина на стоянке ⇒ выезд, иначе въезд;
// время ставит сервер; исправление и аннулирование — только с отметкой
// «кто, когда», ничего не удаляется. Отличия от исходника:
//  • охранник = вошедший по своей учётке (не PIN и не строка-фамилия);
//  • грузовой справочник — тягачи и прицепы планера; свой справочник
//    только у личного и стороннего транспорта;
//  • отметка КПП ФАКТ РЕЙСА НЕ СТАВИТ — пишется в журнал и подсказывает
//    диспетчеру («выехал с базы»), ресурсу и ремзоне («вернулся»).

import { randomUUID } from 'node:crypto';

export const GATE_TYPES = { truck: 'Грузовой', personal: 'Личный', other: 'Сторонний' };
const LAT2CYR = { A: 'А', B: 'В', E: 'Е', K: 'К', M: 'М', H: 'Н', O: 'О', P: 'Р', C: 'С', T: 'Т', Y: 'У', X: 'Х' };

// Номер к единому виду: верхний регистр, латиница-двойник → кириллица,
// Ё → Е, без пробелов и знаков. Им же сравниваются номера планера.
export function normPlate(value) {
  return String(value ?? '').toUpperCase().replace(/Ё/g, 'Е')
    .split('').map(ch => LAT2CYR[ch] || ch).join('').replace(/[^0-9А-Я]/g, '');
}

export function migrateGate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS gate_log (
    id TEXT PRIMARY KEY, plate TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN ('truck','personal','other')),
    vehicle_id TEXT, person TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '', trailer TEXT NOT NULL DEFAULT '',
    entry_at TEXT NOT NULL, entry_by TEXT NOT NULL DEFAULT '', entry_note TEXT NOT NULL DEFAULT '',
    exit_at TEXT, exit_by TEXT NOT NULL DEFAULT '', exit_note TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'onsite' CHECK(status IN ('onsite','out','cancelled')),
    edits TEXT NOT NULL DEFAULT '', hint TEXT NOT NULL DEFAULT '')`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_gate_onsite ON gate_log(status, plate)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_gate_entry ON gate_log(entry_at)`);
  db.exec(`CREATE TABLE IF NOT EXISTS gate_dir (
    plate TEXT PRIMARY KEY, type TEXT NOT NULL CHECK(type IN ('personal','other')),
    model TEXT NOT NULL DEFAULT '', person TEXT NOT NULL DEFAULT '', dept TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
}

// Справочник для подсказки: тягачи и прицепы планера + личный/сторонний.
export function gateDirectory(db) {
  const trucks = db.prepare(`SELECT id, plate, trailer_plate, driver_name, model FROM vehicles WHERE status<>'sold'`).all()
    .map(row => ({ plate: normPlate(row.plate), type: 'truck', vehicleId: row.id, person: row.driver_name || '',
      model: row.model || '', trailer: normPlate(row.trailer_plate) }));
  const own = db.prepare(`SELECT * FROM gate_dir ORDER BY plate`).all()
    .map(row => ({ plate: row.plate, type: row.type, person: row.person, model: row.model, dept: row.dept }));
  return [...trucks, ...own].filter(item => item.plate.length >= 4);
}

const stampOf = (name, at) => `${name || 'без фамилии'}, ${new Date(at).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })}`;

export function gateOnsite(db) {
  return db.prepare(`SELECT * FROM gate_log WHERE status='onsite' ORDER BY entry_at`).all();
}

// Одна кнопка: на стоянке — выезд, иначе въезд. d: {plate, type, person,
// trailer, note, addDir}. Ошибка NEED_TYPE — номер неизвестен, нужен тип.
export function gateRegister(db, guardName, d, at = new Date().toISOString()) {
  const plate = normPlate(d.plate);
  if (plate.length < 4) return { ok: false, error: 'Введите госномер полностью' };
  const onsite = db.prepare(`SELECT * FROM gate_log WHERE status='onsite' AND plate=?`).get(plate);
  if (onsite) {
    db.prepare(`UPDATE gate_log SET status='out', exit_at=?, exit_by=?, exit_note=? WHERE id=?`)
      .run(at, guardName, String(d.note || '').trim(), onsite.id);
    return { ok: true, kind: 'out', record: { ...onsite, exit_at: at, exit_by: guardName } };
  }
  const known = gateDirectory(db).find(item => item.plate === plate);
  const type = GATE_TYPES[d.type] ? d.type : known?.type;
  if (!GATE_TYPES[type]) return { ok: false, error: 'NEED_TYPE' };
  const record = {
    id: randomUUID(), plate, type, vehicle_id: type === 'truck' ? known?.vehicleId || null : null,
    person: String(d.person || '').trim() || known?.person || '', model: known?.model || '',
    trailer: type === 'truck' ? normPlate(d.trailer) || known?.trailer || '' : '',
    entry_at: at, entry_by: guardName, entry_note: String(d.note || '').trim()
  };
  db.prepare(`INSERT INTO gate_log(id,plate,type,vehicle_id,person,model,trailer,entry_at,entry_by,entry_note)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(record.id, record.plate, record.type, record.vehicle_id, record.person,
    record.model, record.trailer, record.entry_at, record.entry_by, record.entry_note);
  if (!known && d.addDir && type !== 'truck') {
    db.prepare(`INSERT OR IGNORE INTO gate_dir(plate,type,person) VALUES(?,?,?)`).run(plate, type, record.person);
  }
  return { ok: true, kind: 'in', record };
}

// «Забыли отметить выезд?» — выезд задним числом с проверкой времени.
export function gateExitAt(db, id, guardName, at, now = Date.now()) {
  const row = db.prepare(`SELECT * FROM gate_log WHERE id=? AND status='onsite'`).get(id);
  if (!row) return { ok: false, error: 'Запись не найдена — обновите страницу' };
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) return { ok: false, error: 'Укажите время выезда' };
  if (ms < Date.parse(row.entry_at)) return { ok: false, error: 'Время выезда раньше времени въезда' };
  if (ms > now + 60_000) return { ok: false, error: 'Время выезда не может быть в будущем' };
  const iso = new Date(ms).toISOString();
  db.prepare(`UPDATE gate_log SET status='out', exit_at=?, exit_by=?, edits=? WHERE id=?`)
    .run(iso, guardName, `${row.edits ? `${row.edits}; ` : ''}выезд задним числом — ${stampOf(guardName, now)}`, id);
  return { ok: true, kind: 'out', record: { ...row, exit_at: iso } };
}

// Исправление записи (времени, примечания, водителя, прицепа) — с отметкой.
export function gateEdit(db, id, guardName, f, now = Date.now()) {
  const row = db.prepare(`SELECT * FROM gate_log WHERE id=? AND status<>'cancelled'`).get(id);
  if (!row) return { ok: false, error: 'Запись не найдена' };
  const entry = f.entryAt ? Date.parse(f.entryAt) : Date.parse(row.entry_at);
  const exit = row.status === 'out' ? (f.exitAt ? Date.parse(f.exitAt) : Date.parse(row.exit_at)) : null;
  if (!Number.isFinite(entry) || entry > now + 60_000) return { ok: false, error: 'Проверьте время въезда' };
  if (exit != null && (!Number.isFinite(exit) || exit < entry)) return { ok: false, error: 'Выезд не может быть раньше въезда' };
  db.prepare(`UPDATE gate_log SET entry_at=?, exit_at=?, person=?, trailer=?, entry_note=?, edits=? WHERE id=?`)
    .run(new Date(entry).toISOString(), exit == null ? null : new Date(exit).toISOString(),
      f.person != null ? String(f.person).trim() : row.person,
      row.type === 'truck' && f.trailer != null ? normPlate(f.trailer) : row.trailer,
      f.note != null ? String(f.note).trim() : row.entry_note,
      `${row.edits ? `${row.edits}; ` : ''}исправил ${stampOf(guardName, now)}`, id);
  return { ok: true };
}

export function gateCancel(db, id, guardName, reason, now = Date.now()) {
  const row = db.prepare(`SELECT * FROM gate_log WHERE id=? AND status<>'cancelled'`).get(id);
  if (!row) return { ok: false, error: 'Запись не найдена' };
  if (!String(reason || '').trim()) return { ok: false, error: 'Укажите причину аннулирования' };
  db.prepare(`UPDATE gate_log SET status='cancelled', edits=? WHERE id=?`)
    .run(`${row.edits ? `${row.edits}; ` : ''}аннулировал ${stampOf(guardName, now)}, причина: ${String(reason).trim()}`, id);
  return { ok: true };
}

const minutes = (a, b) => Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 60000));

// Отчёт за период: визиты, пересекающие период (кроме аннулированных),
// разрезы по типам, машинам и охранникам.
export function gateReport(db, from, to, now = new Date().toISOString()) {
  const visits = db.prepare(`SELECT * FROM gate_log WHERE status<>'cancelled' AND entry_at<?
      AND (exit_at IS NULL OR exit_at>=?) ORDER BY entry_at`).all(to, from)
    .map(row => ({ ...row, minutes: minutes(row.entry_at, row.exit_at || now) }));
  const group = key => {
    const map = new Map();
    for (const visit of visits) {
      const k = key(visit);
      const item = map.get(k) || { key: k, visits: 0, minutes: 0 };
      item.visits += 1;
      item.minutes += visit.minutes;
      map.set(k, item);
    }
    return [...map.values()].sort((a, b) => b.visits - a.visits);
  };
  const cancelled = db.prepare(`SELECT COUNT(*) n FROM gate_log WHERE status='cancelled' AND entry_at<? AND entry_at>=?`).get(to, from).n;
  return { from, to, visits, cancelled, byType: group(visit => visit.type), byPlate: group(visit => visit.plate),
    byGuard: group(visit => visit.entry_by) };
}

// Подсказки по отметке (факт НЕ ставится — решение 07.11). Возвращает
// [{role, text, entity, entityId}] — сервер отправляет их уведомлениями.
export function gateHints(db, result, guardName) {
  const record = result.record;
  if (record.type !== 'truck' || !record.vehicle_id) return [];
  const at = result.kind === 'out' ? record.exit_at : record.entry_at;
  const time = new Date(at).toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' });
  if (result.kind === 'out') {
    // Ближайший незавершённый рейс машины — диспетчер решает, ставить ли факт.
    const trip = db.prepare(`SELECT t.id, t.starts_at, t.order_no, f.name from_name, z.name to_name FROM trips t
      JOIN zones f ON f.id=t.from_zone_id JOIN zones z ON z.id=t.to_zone_id
      WHERE t.vehicle_id=? AND (t.status='plan' OR (t.status='run' AND t.on_line_at IS NULL))
      ORDER BY ABS(julianday(t.starts_at) - julianday(?)) LIMIT 1`).get(record.vehicle_id, at);
    const transfer = db.prepare(`SELECT id, starts_at FROM vehicle_dispositions WHERE vehicle_id=? AND kind='transfer'
      AND departed_at IS NULL ORDER BY ABS(julianday(starts_at) - julianday(?)) LIMIT 1`).get(record.vehicle_id, at);
    const target = trip
      ? `ближайший рейс${trip.order_no ? ` № ${trip.order_no}` : ''} ${trip.from_name} → ${trip.to_name}, план выхода ${new Date(trip.starts_at).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`
      : transfer ? 'запланирован перегон' : 'рейса и перегона в плане нет';
    return [{ role: 'dispatcher', entity: trip ? 'trip' : 'vehicle', entityId: trip?.id || record.vehicle_id,
      text: `🚧 КПП Пенза: ${record.plate} выехал с базы в ${time} (${guardName}) — ${target}. Факт выезда не поставлен: проверьте и отметьте в карточке.` }];
  }
  const hints = [{ role: 'resource', entity: 'vehicle', entityId: record.vehicle_id,
    text: `🚧 КПП Пенза: ${record.plate} вернулся на базу в ${time} (${guardName})${record.person ? `, водитель ${record.person}` : ''}.` }];
  const repair = db.prepare(`SELECT id FROM repair_orders WHERE vehicle_id=? AND status='queued' AND arrived_at IS NULL LIMIT 1`)
    .get(record.vehicle_id);
  if (repair) {
    hints.push({ role: 'mechanic', entity: 'vehicle', entityId: record.vehicle_id,
      text: `🚧 КПП Пенза: ${record.plate} на базе с ${time} — заезд в ремзону ждёт приёмки.` });
  }
  return hints;
}
