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

// Этапы претензионной работы по ДТП — значения статуса документа «ДТП»
// в 1С:УАТ (данные классификатора, не бизнес-константы планера): порядок
// воронки и человеческие подписи. Незнакомый статус показывается как есть.
export const CLAIM_STAGES = ['Новый', 'ДокументыПодготовлены', 'ДокументыПоданыВСК', 'ОсмотрПройденВСК',
  'ВРАботеЮрОтдела', 'НаправлениеСТОА', 'ПЗН', 'ВРаботе', 'РемонтАТП', 'Выполнен'];
export const CLAIM_LABELS = {
  'Новый': 'новое', 'ДокументыПодготовлены': 'документы подготовлены', 'ДокументыПоданыВСК': 'поданы в СК',
  'ОсмотрПройденВСК': 'осмотр пройден', 'ВРАботеЮрОтдела': 'юротдел', 'НаправлениеСТОА': 'направление СТОА',
  'ПЗН': 'ПЗН', 'ВРаботе': 'в работе', 'РемонтАТП': 'ремонт АТП', 'Выполнен': 'выполнено'
};

export function migrateSafety(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS safety_events (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('dtp','pdd','rto','briefing','admission','other')),
    driver_id TEXT, driver_name TEXT NOT NULL DEFAULT '', vehicle_id TEXT, plate TEXT NOT NULL DEFAULT '',
    happened_on TEXT NOT NULL, valid_until TEXT, description TEXT NOT NULL DEFAULT '', measures TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
    created_by_name TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    closed_at TEXT, closed_by_name TEXT NOT NULL DEFAULT '')`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_safety_driver ON safety_events(driver_id, happened_on)`);
  // Вариант Б (14.11): карточка ДТП ведёт претензионную работу — внешний
  // номер 1С (идемпотентный импорт), виновность, этап дела СК, страховая,
  // номер дела и выплаченное возмещение.
  const have = new Set(db.prepare(`PRAGMA table_info(safety_events)`).all().map(column => column.name));
  const ensure = (column, definition) => { if (!have.has(column)) db.exec(`ALTER TABLE safety_events ADD COLUMN ${column} ${definition}`); };
  ensure('external_no', `TEXT NOT NULL DEFAULT ''`);
  ensure('culpability', `TEXT NOT NULL DEFAULT '' CHECK(culpability IN ('','guilty','notguilty'))`);
  ensure('claim_status', `TEXT NOT NULL DEFAULT ''`);
  ensure('insurer', `TEXT NOT NULL DEFAULT ''`);
  ensure('claim_no', `TEXT NOT NULL DEFAULT ''`);
  ensure('paid_rub', `REAL NOT NULL DEFAULT 0`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_safety_external ON safety_events(external_no)`);
}

// ФИО к виду для сопоставления: нижний регистр, «ё»→«е», одиночные пробелы.
const normName = value => String(value || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
// Госномер к виду планера: латиница→кириллица, без пробелов, нижний регистр.
const LATIN = 'ABEKMHOPCTYXabekmhopctyx';
const CYR = 'АВЕКМНОРСТУХавекмнорстух';
const normPlate = value => String(value || '')
  .replace(/[A-Za-z]/g, ch => { const i = LATIN.indexOf(ch); return i >= 0 ? CYR[i] : ch; })
  .replace(/\s+/g, '').toLowerCase();

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
  const culpability = ['guilty', 'notguilty'].includes(body.culpability) ? body.culpability : '';
  const id = randomUUID();
  db.prepare(`INSERT INTO safety_events(id,kind,driver_id,driver_name,vehicle_id,plate,happened_on,valid_until,
      description,measures,status,created_by_name,culpability) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, body.kind, driver?.id || null, driver?.full_name || '', vehicle?.id || null, vehicle?.plate || '',
      body.happenedOn, WITH_TERM.has(body.kind) ? body.validUntil : null,
      String(body.description || '').trim(), String(body.measures || '').trim(),
      WITH_TERM.has(body.kind) ? 'closed' : 'open', name, body.kind === 'dtp' ? culpability : '');
  return { ok: true, id };
}

// Импорт ДТП из выгрузки 1С:УАТ (лист «ДТП»). Идемпотентно: ключ —
// внешний номер документа; повторная выгрузка обновляет поля 1С, а не
// дублирует. Поля 1С — источник истины (журнал ведётся там), кроме двух
// уважений к локальной работе: закрытое в планере расследование не
// вскрывается, непустые локальные меры не затираются пустыми из 1С.
export function importDtpRows(db, rows, name, nowIso = new Date().toISOString()) {
  const byFio = new Map(db.prepare(`SELECT id, full_name FROM drivers`).all()
    .map(row => [normName(row.full_name), row]));
  const byPlate = new Map(db.prepare(`SELECT id, plate FROM vehicles`).all()
    .map(row => [normPlate(row.plate), row]));
  const find = db.prepare(`SELECT * FROM safety_events WHERE kind='dtp' AND external_no=?`);
  const insert = db.prepare(`INSERT INTO safety_events(id,kind,driver_id,driver_name,vehicle_id,plate,happened_on,
    description,measures,status,created_by_name,external_no,culpability,claim_status,claim_no,paid_rub,closed_at,closed_by_name)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const update = db.prepare(`UPDATE safety_events SET happened_on=?, driver_id=?, driver_name=?, vehicle_id=?, plate=?,
    description=?, measures=?, culpability=?, claim_status=?, claim_no=?, paid_rub=?,
    status=?, closed_at=COALESCE(closed_at,?), closed_by_name=CASE WHEN closed_by_name='' THEN ? ELSE closed_by_name END
    WHERE id=?`);
  let added = 0, updated = 0;
  const skipped = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const externalNo = String(row.externalNo || '').trim();
    const happenedOn = String(row.happenedOn || '').slice(0, 10);
    if (!externalNo || !/^\d{4}-\d{2}-\d{2}$/.test(happenedOn)) {
      skipped.push(`${externalNo || '(без номера)'}: нет номера или даты`);
      continue;
    }
    // Прицепов в справочнике машин нет: если госномер не нашёлся,
    // привязываем к тягачу сцепки (номер прицепа остаётся в тексте).
    const direct = byPlate.get(normPlate(row.plate)) || null;
    const paired = !direct && row.pairedPlate ? byPlate.get(normPlate(row.pairedPlate)) || null : null;
    const vehicle = direct || paired;
    const driver = byFio.get(normName(row.driverName)) || null;
    if (!vehicle && !driver && !String(row.driverName || row.plate || '').trim()) {
      skipped.push(`${externalNo}: не указаны ни машина, ни водитель`);
      continue;
    }
    const plateText = direct ? direct.plate : String(row.plate || '').trim();
    const culpability = /не\s*винов/i.test(String(row.culpability || '')) ? 'notguilty'
      : /винов/i.test(String(row.culpability || '')) ? 'guilty' : '';
    const description = [String(row.place || '').trim(), String(row.damage || '').trim()]
      .filter(Boolean).join(' — ').slice(0, 2000);
    const measures = [String(row.analysis || '').trim(), String(row.comment || '').trim()]
      .filter(Boolean).join('\n').slice(0, 2000);
    const claimStatus = String(row.claimStatus || '').trim();
    const closed = claimStatus === 'Выполнен';
    const paidRub = Number(row.paidRub) || 0;
    const existing = find.get(externalNo);
    if (existing) {
      update.run(happenedOn, driver?.id || existing.driver_id, driver?.full_name || String(row.driverName || existing.driver_name).trim(),
        vehicle?.id || existing.vehicle_id, plateText || existing.plate,
        description || existing.description, measures || existing.measures, culpability, claimStatus,
        String(row.claimNo || '').trim(), paidRub,
        closed || existing.status === 'closed' ? 'closed' : 'open',
        closed ? nowIso : null, closed ? name : '', existing.id);
      updated += 1;
    } else {
      insert.run(randomUUID(), 'dtp', driver?.id || null, driver?.full_name || String(row.driverName || '').trim(),
        vehicle?.id || null, plateText, happenedOn,
        description, measures, closed ? 'closed' : 'open', name, externalNo, culpability, claimStatus,
        String(row.claimNo || '').trim(), paidRub, closed ? nowIso : null, closed ? name : '');
      added += 1;
    }
  }
  return { ok: true, added, updated, skipped };
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
  // Машины по ДТП периода — хронические борта видно сразу.
  const byVehicle = new Map();
  for (const event of events.filter(row => row.kind === 'dtp' && row.plate)) {
    const item = byVehicle.get(normPlate(event.plate)) || { plate: event.plate, dtp: 0, guilty: 0 };
    item.dtp += 1;
    if (event.culpability === 'guilty') item.guilty += 1;
    byVehicle.set(normPlate(event.plate), item);
  }
  // Пробег периода — знаменатель аварийности (факт км рейсов, без плана).
  const kmBetween = db.prepare(`SELECT COALESCE(SUM(COALESCE(actual_distance_km, distance_km)),0) km
    FROM trips WHERE starts_at>=? AND starts_at<? AND status<>'rejected'`);
  const periodKm = kmBetween.get(`${from}T00:00:00`, `${to}T23:59:59`).km;
  // Динамика 6 месяцев (заканчивая месяцем «по»): ДТП, виновность,
  // аварийность на 1 млн км — живой знаменатель из фактических рейсов.
  const monthDtp = db.prepare(`SELECT COUNT(*) n,
      SUM(CASE WHEN culpability='guilty' THEN 1 ELSE 0 END) guilty,
      SUM(CASE WHEN culpability='notguilty' THEN 1 ELSE 0 END) notguilty
    FROM safety_events WHERE kind='dtp' AND happened_on>=? AND happened_on<=?`);
  const months = [];
  const [toYear, toMonth] = to.split('-').map(Number);
  for (let back = 5; back >= 0; back -= 1) {
    const date = new Date(Date.UTC(toYear, toMonth - 1 - back, 1));
    const next = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
    const first = date.toISOString().slice(0, 10);
    const last = new Date(next.getTime() - 864e5).toISOString().slice(0, 10);
    const counts = monthDtp.get(first, last);
    const km = kmBetween.get(`${first}T00:00:00`, `${next.toISOString().slice(0, 10)}T00:00:00`).km;
    months.push({ month: first.slice(0, 7), dtp: counts.n, guilty: counts.guilty || 0,
      notguilty: counts.notguilty || 0, km: Math.round(km),
      per1m: km > 0 ? Math.round(counts.n * 1e9 / km) / 1000 : null });
  }
  // Дела страховых: открытые ДТП с возрастом — порога «застряло» нет,
  // человек видит возраст и решает сам (живая сортировка от старых).
  const todayMs = Date.parse(`${today}T00:00:00Z`);
  const claims = db.prepare(`SELECT id, external_no, happened_on, plate, driver_name, culpability,
      claim_status, claim_no, paid_rub FROM safety_events
    WHERE kind='dtp' AND status='open' ORDER BY happened_on`).all()
    .map(row => ({ ...row, ageDays: Math.max(0, Math.round((todayMs - Date.parse(`${row.happened_on}T00:00:00Z`)) / 864e5)) }));
  const funnelMap = new Map();
  for (const claim of claims) {
    const key = claim.claim_status || '(этап не указан)';
    funnelMap.set(key, (funnelMap.get(key) || 0) + 1);
  }
  const claimFunnel = [...CLAIM_STAGES, '(этап не указан)']
    .filter(stage => funnelMap.has(stage))
    .map(stage => ({ stage, label: CLAIM_LABELS[stage] || stage, count: funnelMap.get(stage) }));
  for (const [stage, count] of funnelMap) {
    if (!CLAIM_STAGES.includes(stage) && stage !== '(этап не указан)') claimFunnel.push({ stage, label: stage, count });
  }
  const dtpEvents = events.filter(row => row.kind === 'dtp');
  return {
    from, to, warnDays, events, open, months, claims, claimFunnel,
    byVehicle: [...byVehicle.values()].sort((a, b) => b.dtp - a.dtp || b.guilty - a.guilty),
    terms: terms.filter(row => row.termStatus !== 'ok').sort((a, b) => a.valid_until.localeCompare(b.valid_until)),
    withoutAdmission: drivers.filter(driver => !admitted.has(driver.id)).map(driver => ({ id: driver.id, name: driver.full_name })),
    byDriver: [...byDriver.values()].sort((a, b) => (b.dtp * 10 + b.rto * 3 + b.pdd) - (a.dtp * 10 + a.rto * 3 + a.pdd)),
    summary: { dtp: dtpEvents.length, pdd: events.filter(row => row.kind === 'pdd').length,
      rto: events.filter(row => row.kind === 'rto').length, open: open.length,
      termsDue: terms.filter(row => row.termStatus !== 'ok').length, drivers: drivers.length,
      dtpGuilty: dtpEvents.filter(row => row.culpability === 'guilty').length,
      dtpNotGuilty: dtpEvents.filter(row => row.culpability === 'notguilty').length,
      paidRub: dtpEvents.reduce((sum, row) => sum + (row.paid_rub || 0), 0),
      periodKm: Math.round(periodKm),
      per1m: periodKm > 0 ? Math.round(dtpEvents.length * 1e9 / periodKm) / 1000 : null }
  };
}
