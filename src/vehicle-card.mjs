// «Карточка ТС» — полный набор данных по единице техники «по принципу 1С»
// (решение руководителя 07.11.2026: «межсервисные интервалы и всё прочее
// устанавливаются ВРУЧНУЮ на каждую единицу техники; в ремзоне и в
// эксплуатации должна появиться карточка ТС; заполним после старта»).
//
// Что здесь своё: таблица vehicle_cards (реквизиты, сроки документов,
// нормы ТО на КАЖДУЮ машину). Всё остальное читается из существующих
// таблиц планера и не дублируется: vehicles/vehicle_types/trailers
// (номер, модель, сцепка, водитель, статус), repair_orders (заезды
// Ремзоны, последний ТО), vehicle_odometers (журнал одометров 00:00 МСК),
// trips, gate_log (если модуль КПП уже создал таблицу), waybills.
// Затраты по машине в карточке НЕ показываются — они под персональным
// доступом (раздел «Затраты»).
//
// Живые нормативы (CLAUDE.md): своих бизнес-констант нет.
//   • Межсервисный интервал — только вручную на машину; не задан → статус
//     'no_norm', ничего не выдумываем.
//   • «Скоро ТО» — остаток до ТО меньше СОБСТВЕННОГО пробега машины за
//     горизонт плана: среднесуточный пробег = медиана положительных
//     суточных разностей журнала одометров за последние 28 суток (окно
//     задано руководителем в постановке 07.11), горизонт —
//     settings.calculation.planHorizonDays.
//   • «Скоро» для документов — settings.calculation.docsWarnDays.
//
// Права (одно техническое право на правку — fleet:write): раздел «Нормы ТО»
// по смыслу ведёт ТОиР (механик), «Документы и сроки» — эксплуатация
// (Ресурс); у обеих ролей право fleet:write, поэтому технически правка
// одна. Читают: fleet:write, release:write, reports:read или роль с
// экраном «Ремзона»/«Ресурс»/«Выпуск».

const DAY_MS = 864e5;
const MSK = 3 * 3_600_000;
const mskDay = ms => new Date(ms + MSK).toISOString().slice(0, 10);
const dayMs = day => Date.parse(`${day}T00:00:00Z`) - MSK; // 00:00 МСК этого дня
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);

// Окно собственного пробега — из постановки руководителя 07.11 («за
// последние 28 суток»): четыре полные недели, выходные не перекашивают.
const OWN_RUN_WINDOW_DAYS = 28;

// Поля карточки: тип и подпись (подписи — для журнала аудита и подсказок).
export const CARD_FIELDS = {
  vin: ['text', 'VIN'], year: ['year', 'Год выпуска'], sts_number: ['text', 'СТС'], pts_number: ['text', 'ПТС'],
  owner: ['text', 'Собственник'], lessor: ['text', 'Лизингодатель'], lease_until: ['date', 'Лизинг до'],
  osago_until: ['date', 'ОСАГО до'], kasko_until: ['date', 'КАСКО до'],
  techinspect_until: ['date', 'Техосмотр (диагн. карта) до'], tacho_until: ['date', 'Тахограф (поверка/карта) до'],
  glonass_id: ['text', 'ID ГЛОНАСС'], tracker: ['text', 'Трекер'], note: ['text', 'Примечание'],
  to_interval_km: ['positive', 'Межсервисный интервал, км'], hou_interval_mh: ['positive', 'ТО ХОУ, моточасы'],
  tires_note: ['text', 'Шины']
};

// Документы со сроком: ключ → [поле карточки, название].
export const CARD_DOCS = [
  ['osago', 'osago_until', 'ОСАГО'], ['kasko', 'kasko_until', 'КАСКО'],
  ['techinspect', 'techinspect_until', 'Техосмотр'], ['tacho', 'tacho_until', 'Тахограф'],
  ['lease', 'lease_until', 'Лизинг']
];

export function migrateVehicleCards(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS vehicle_cards (
    vehicle_id TEXT PRIMARY KEY REFERENCES vehicles(id) ON DELETE CASCADE,
    vin TEXT NOT NULL DEFAULT '', year INTEGER, sts_number TEXT NOT NULL DEFAULT '',
    pts_number TEXT NOT NULL DEFAULT '', owner TEXT NOT NULL DEFAULT '', lessor TEXT NOT NULL DEFAULT '',
    lease_until TEXT, osago_until TEXT, kasko_until TEXT, techinspect_until TEXT, tacho_until TEXT,
    glonass_id TEXT NOT NULL DEFAULT '', tracker TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
    to_interval_km REAL, hou_interval_mh REAL, tires_note TEXT NOT NULL DEFAULT '',
    updated_at TEXT, updated_by_name TEXT NOT NULL DEFAULT '')`);
}

const hasTable = (db, name) => Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name));

// Горизонт плана: settings.calculation.planHorizonDays; пусто → 3 сут —
// утверждённый руководителем горизонт расписания (лаборатория расписания,
// 19.10), а не новая цифра. Ноль — осознанное значение («скоро» не ставим).
export const planHorizonOf = settings => {
  const raw = settings?.calculation?.planHorizonDays;
  const value = Number(raw);
  return raw !== '' && raw != null && Number.isFinite(value) && value >= 0 ? value : 3;
};
// Порог «скоро истекает» для документов: settings.calculation.docsWarnDays;
// пусто → 30 сут — цель по умолчанию, правится в Настройках.
export const docsWarnOf = settings => {
  const raw = settings?.calculation?.docsWarnDays;
  const value = Number(raw);
  return raw !== '' && raw != null && Number.isFinite(value) && value >= 0 ? value : 30;
};

// ── Пробег по журналу одометров ──
// Собственный среднесуточный пробег: медиана положительных суточных
// разностей за последние 28 суток. Пропуски журнала (нет снимка за день)
// делят разность на число суток между снимками. Нулевые/отрицательные
// разности (стоянка, сбой датчика) в медиану не входят: нужна скорость
// «когда машина работает», иначе стоянка в ремонте занизит прогноз.
export function ownDailyKm(db, vehicleId, todayDay) {
  const from = addDays(todayDay, -OWN_RUN_WINDOW_DAYS);
  const rows = db.prepare(`SELECT day, odo_km FROM vehicle_odometers
    WHERE vehicle_id=? AND day>=? AND day<=? ORDER BY day`).all(vehicleId, from, todayDay);
  const perDay = [];
  for (let i = 1; i < rows.length; i += 1) {
    const gap = daysBetween(rows[i - 1].day, rows[i].day);
    const diff = rows[i].odo_km - rows[i - 1].odo_km;
    if (gap > 0 && diff > 0) perDay.push(diff / gap);
  }
  if (!perDay.length) return null;
  perDay.sort((a, b) => a - b);
  const mid = Math.floor(perDay.length / 2);
  return perDay.length % 2 ? perDay[mid] : (perDay[mid - 1] + perDay[mid]) / 2;
}

// Одометр на момент выпуска после ТО. Снимок журнала — на 00:00 МСК дня.
// Правило выбора:
//   1) снимок «не позже» выпуска (последний day ≤ день выпуска МСК), если он
//      снят, пока машина стояла в Ремзоне (day ≥ день заезда): за стоянку
//      машина не ездит, этот снимок и есть одометр на ТО;
//   2) иначе — ближайший по времени к моменту выпуска из двух соседей
//      (последний до и первый после), чтобы старый снимок до долгого
//      пропуска журнала не приписал ТО чужой пробег.
// Возвращает { day, odo_km, side: 'before'|'after' } или null.
export function odometerAtRelease(db, vehicleId, releasedAt, arrivedAt = null) {
  const releaseMs = Date.parse(releasedAt);
  if (!Number.isFinite(releaseMs)) return null;
  const releaseDay = mskDay(releaseMs);
  const before = db.prepare(`SELECT day, odo_km FROM vehicle_odometers WHERE vehicle_id=? AND day<=?
    ORDER BY day DESC LIMIT 1`).get(vehicleId, releaseDay);
  const after = db.prepare(`SELECT day, odo_km FROM vehicle_odometers WHERE vehicle_id=? AND day>?
    ORDER BY day LIMIT 1`).get(vehicleId, releaseDay);
  const arrivedMs = Date.parse(arrivedAt || '');
  if (before && Number.isFinite(arrivedMs) && before.day >= mskDay(arrivedMs)) return { ...before, side: 'before' };
  if (!before && !after) return null;
  if (!after) return { ...before, side: 'before' };
  if (!before) return { ...after, side: 'after' };
  return releaseMs - dayMs(before.day) <= dayMs(after.day) - releaseMs
    ? { ...before, side: 'before' } : { ...after, side: 'after' };
}

const lastToOrder = (db, vehicleId) => db.prepare(`SELECT id, arrived_at, released_at FROM repair_orders
  WHERE vehicle_id=? AND purpose='ТО' AND status='released' AND released_at IS NOT NULL
  ORDER BY released_at DESC LIMIT 1`).get(vehicleId);

// Состояние ТО по пробегу одной машины. opts: { nowMs, horizonDays }.
export function toStatusOf(db, vehicleId, card, opts = {}) {
  const nowMs = opts.nowMs ?? Date.now();
  const horizonDays = opts.horizonDays ?? 3; // см. planHorizonOf: горизонт расписания 19.10
  const today = mskDay(nowMs);
  const intervalKm = Number(card?.to_interval_km) > 0 ? Number(card.to_interval_km) : null;
  const avgDayKm = ownDailyKm(db, vehicleId, today);
  const last = lastToOrder(db, vehicleId);
  const result = { status: 'no_norm', intervalKm, sinceKm: null, leftKm: null, avgDayKm,
    lastToAt: last?.released_at ?? null, odoNowKm: null, odoNowDay: null, odoBase: null, reason: '', horizonDays };
  if (intervalKm == null) { result.reason = 'межсервисный интервал не задан в карточке'; return result; }
  result.status = 'no_data';
  const now = db.prepare(`SELECT day, odo_km FROM vehicle_odometers WHERE vehicle_id=? AND day<=?
    ORDER BY day DESC LIMIT 1`).get(vehicleId, today);
  if (!last) { result.reason = 'в Ремзоне нет выпуска после ТО'; return result; }
  if (!now) { result.reason = 'нет снимков одометра'; return result; }
  const base = odometerAtRelease(db, vehicleId, last.released_at, last.arrived_at);
  result.odoNowKm = now.odo_km;
  result.odoNowDay = now.day;
  result.odoBase = base;
  if (!base) { result.reason = 'нет снимка одометра около выпуска после ТО'; return result; }
  const sinceKm = now.odo_km - base.odo_km;
  if (sinceKm < 0) { result.reason = 'одометр сейчас меньше, чем на ТО — сбой датчика или замена'; return result; }
  result.sinceKm = Math.round(sinceKm);
  result.leftKm = Math.round(intervalKm - sinceKm);
  if (result.leftKm <= 0) result.status = 'overdue';
  else if (avgDayKm != null && result.leftKm < avgDayKm * horizonDays) result.status = 'soon';
  else result.status = 'ok';
  return result;
}

// Срок документа: 'unknown' (не внесён), 'expired', 'soon' (≤ порога), 'ok'.
export function docStatus(until, todayDay, warnDays) {
  if (!until || !/^\d{4}-\d{2}-\d{2}$/.test(until)) return { status: 'unknown', daysLeft: null };
  const daysLeft = daysBetween(todayDay, until);
  return { status: daysLeft < 0 ? 'expired' : daysLeft <= warnDays ? 'soon' : 'ok', daysLeft };
}

export function docsOf(card, todayDay, warnDays) {
  return CARD_DOCS.map(([doc, field, label]) => ({ doc, label, until: card?.[field] || null,
    ...docStatus(card?.[field] || null, todayDay, warnDays) }));
}

const parkVehicles = db => db.prepare(`SELECT v.id, v.plate FROM vehicles v
  WHERE v.out_since IS NULL ORDER BY v.plate`).all();
const cardMap = db => new Map(db.prepare('SELECT * FROM vehicle_cards').all().map(row => [row.vehicle_id, row]));
const settingsOpts = (db, opts) => {
  if (opts.horizonDays != null && opts.warnDays != null) return opts;
  const settings = opts.settings ?? Object.fromEntries(db.prepare('SELECT key,value_json FROM settings').all()
    .map(row => [row.key, JSON.parse(row.value_json)]));
  return { ...opts, horizonDays: opts.horizonDays ?? planHorizonOf(settings), warnDays: opts.warnDays ?? docsWarnOf(settings) };
};

export const TO_ORDER = { overdue: 0, soon: 1, ok: 2, no_data: 3, no_norm: 4 };

// ТО по парку (для опережающих сигналов и стыка «Логистика→ТОиР»).
// opts: { nowMs, horizonDays, settings }. Сортировка: просрочено → скоро →
// ок (по остатку) → нет данных → нет нормы.
export function toStatusAll(db, opts = {}) {
  const o = settingsOpts(db, { ...opts, warnDays: opts.warnDays ?? 0 });
  const cards = cardMap(db);
  return parkVehicles(db).map(vehicle => {
    const s = toStatusOf(db, vehicle.id, cards.get(vehicle.id), o);
    return { vehicleId: vehicle.id, plate: vehicle.plate, status: s.status, sinceKm: s.sinceKm,
      intervalKm: s.intervalKm, leftKm: s.leftKm, avgDayKm: s.avgDayKm == null ? null : Math.round(s.avgDayKm),
      lastToAt: s.lastToAt, reason: s.reason };
  }).sort((a, b) => TO_ORDER[a.status] - TO_ORDER[b.status] || (a.leftKm ?? Infinity) - (b.leftKm ?? Infinity)
    || a.plate.localeCompare(b.plate, 'ru'));
}

// Сроки документов по парку. По умолчанию — только требующие действия
// (expired, soon); opts.all — все внесённые и не внесённые.
export function docsDueAll(db, opts = {}) {
  const o = settingsOpts(db, { ...opts, horizonDays: opts.horizonDays ?? 0 });
  const today = mskDay(o.nowMs ?? Date.now());
  const cards = cardMap(db);
  const rank = { expired: 0, soon: 1, ok: 2, unknown: 3 };
  const rows = [];
  for (const vehicle of parkVehicles(db)) {
    for (const item of docsOf(cards.get(vehicle.id), today, o.warnDays)) {
      if (!o.all && item.status !== 'expired' && item.status !== 'soon') continue;
      rows.push({ vehicleId: vehicle.id, plate: vehicle.plate, doc: item.doc, label: item.label,
        until: item.until, daysLeft: item.daysLeft, status: item.status });
    }
  }
  return rows.sort((a, b) => rank[a.status] - rank[b.status] || (a.daysLeft ?? Infinity) - (b.daysLeft ?? Infinity));
}

// ── Карточка целиком ──
export function vehicleCard(db, vehicleId, opts = {}) {
  const vehicle = db.prepare(`SELECT v.id, v.plate, v.model, v.trailer_plate, v.driver_name, v.status, v.out_since,
    t.name AS type_name FROM vehicles v LEFT JOIN vehicle_types t ON t.id=v.type_id WHERE v.id=?`).get(vehicleId);
  if (!vehicle) return null;
  const o = settingsOpts(db, opts);
  const nowMs = o.nowMs ?? Date.now();
  const today = mskDay(nowMs);
  const card = db.prepare('SELECT * FROM vehicle_cards WHERE vehicle_id=?').get(vehicleId) || null;
  const trailerPlate = String(vehicle.trailer_plate || '').toUpperCase().replace(/\s+/g, ' ').trim();
  const trailer = trailerPlate && hasTable(db, 'trailers')
    ? db.prepare('SELECT plate, model FROM trailers WHERE plate=?').get(trailerPlate) || null : null;
  const limit = Number(opts.historyLimit) > 0 ? Number(opts.historyLimit) : 10;
  const history = {
    repairs: db.prepare(`SELECT id, arrived_at, released_at, purpose, complaint, status FROM repair_orders
      WHERE vehicle_id=? ORDER BY COALESCE(arrived_at, created_at) DESC LIMIT ?`).all(vehicleId, limit),
    trips: db.prepare(`SELECT t.id, t.starts_at, t.status, fz.name AS from_zone, tz.name AS to_zone
      FROM trips t LEFT JOIN zones fz ON fz.id=t.from_zone_id LEFT JOIN zones tz ON tz.id=t.to_zone_id
      WHERE t.vehicle_id=? ORDER BY t.starts_at DESC LIMIT ?`).all(vehicleId, limit),
    gate: hasTable(db, 'gate_log') ? db.prepare(`SELECT id, entry_at, exit_at, status FROM gate_log
      WHERE vehicle_id=? ORDER BY entry_at DESC LIMIT ?`).all(vehicleId, limit) : null,
    waybills: hasTable(db, 'waybills') ? db.prepare(`SELECT id, year, number, starts_at, status FROM waybills
      WHERE vehicle_id=? ORDER BY starts_at DESC LIMIT ?`).all(vehicleId, limit) : null
  };
  return {
    vehicle: { id: vehicle.id, plate: vehicle.plate, model: vehicle.model || '', type: vehicle.type_name || '',
      trailerPlate: vehicle.trailer_plate || '', trailerModel: trailer?.model || '', driver: vehicle.driver_name || '',
      status: vehicle.status, outSince: vehicle.out_since || null },
    card: Object.fromEntries(Object.keys(CARD_FIELDS).map(key => [key, card?.[key] ?? null])),
    updatedAt: card?.updated_at || null, updatedBy: card?.updated_by_name || '',
    to: toStatusOf(db, vehicleId, card, { nowMs, horizonDays: o.horizonDays }),
    docs: docsOf(card, today, o.warnDays),
    warnDays: o.warnDays, horizonDays: o.horizonDays, history
  };
}

// Нормализация правки: пустое → null/''; ошибки — человеческим текстом.
export function normalizeCardPatch(body = {}) {
  const patch = {};
  const nextYear = new Date().getUTCFullYear() + 1;
  for (const [key, value] of Object.entries(body)) {
    const spec = CARD_FIELDS[key];
    if (!spec) continue;
    const [kind, label] = spec;
    const raw = value == null ? '' : String(value).trim();
    if (kind === 'text') { patch[key] = raw.slice(0, 2000); continue; }
    if (raw === '') { patch[key] = null; continue; }
    if (kind === 'date') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(Date.parse(`${raw}T00:00:00Z`))) return { error: `${label}: дата в формате ГГГГ-ММ-ДД` };
      patch[key] = raw;
    } else if (kind === 'year') {
      const year = Number(raw);
      if (!Number.isInteger(year) || year < 1900 || year > nextYear) return { error: `${label}: укажите год четырьмя цифрами` };
      patch[key] = year;
    } else {
      const number = Number(raw.replace(',', '.').replace(/\s+/g, ''));
      if (!Number.isFinite(number) || number <= 0) return { error: `${label}: положительное число или пусто` };
      patch[key] = number;
    }
  }
  if (!Object.keys(patch).length) return { error: 'Нет полей для сохранения' };
  return { patch };
}

export function saveVehicleCard(db, vehicleId, body, userName, at = new Date().toISOString()) {
  if (!db.prepare('SELECT 1 FROM vehicles WHERE id=?').get(vehicleId)) return { ok: false, status: 404, error: 'Машина не найдена' };
  const { patch, error } = normalizeCardPatch(body);
  if (error) return { ok: false, status: 422, error };
  const before = db.prepare('SELECT * FROM vehicle_cards WHERE vehicle_id=?').get(vehicleId) || {};
  db.prepare(`INSERT INTO vehicle_cards(vehicle_id) VALUES(?) ON CONFLICT(vehicle_id) DO NOTHING`).run(vehicleId);
  const keys = Object.keys(patch);
  db.prepare(`UPDATE vehicle_cards SET ${keys.map(key => `${key}=?`).join(',')}, updated_at=?, updated_by_name=?
    WHERE vehicle_id=?`).run(...keys.map(key => patch[key]), at, userName || '', vehicleId);
  const changes = {};
  for (const key of keys) {
    const was = before[key] ?? (CARD_FIELDS[key][0] === 'text' ? '' : null);
    if (was !== patch[key]) changes[key] = { from: was, to: patch[key] };
  }
  return { ok: true, changes };
}

// Права карточки: читать и править.
export function vehicleCardRights(user, access, hasPermission) {
  const views = access?.legacy ? [] : (access?.views || []);
  const write = hasPermission(user, 'fleet:write');
  const read = write || hasPermission(user, 'release:write') || hasPermission(user, 'reports:read')
    || ['remzona', 'resource', 'release'].some(view => views.includes(view));
  return { read, write };
}

// Обработчик /api/vehicle-card/*. Возвращает true, если запрос обработан.
export async function vehicleCardApi(ctx) {
  const { db, request, response, pathname, user, access, json, errorJson, readJson, audit, requestIp, settingsObject, hasPermission } = ctx;
  if (!(pathname === '/api/vehicle-card' || pathname.startsWith('/api/vehicle-card/'))) return false;
  const rights = vehicleCardRights(user, access, hasPermission);
  if (!rights.read) { errorJson(response, 403, 'Карточка ТС — для Ремзоны, Ресурса, Выпуска и руководителя'); return true; }
  const settings = settingsObject(db);
  const opts = { horizonDays: planHorizonOf(settings), warnDays: docsWarnOf(settings), settings };
  const rest = decodeURIComponent(pathname.slice('/api/vehicle-card/'.length));
  if (request.method === 'GET' && rest === 'to-status') {
    json(response, 200, { items: toStatusAll(db, opts), horizonDays: opts.horizonDays, canWrite: rights.write });
    return true;
  }
  if (request.method === 'GET' && rest === 'docs-due') {
    json(response, 200, { items: docsDueAll(db, { ...opts, all: ctx.url?.searchParams?.get('all') === '1' }), warnDays: opts.warnDays });
    return true;
  }
  if (!rest || rest.includes('/')) { errorJson(response, 404, 'Нет такого раздела карточки ТС'); return true; }
  if (request.method === 'GET') {
    const card = vehicleCard(db, rest, opts);
    if (!card) { errorJson(response, 404, 'Машина не найдена'); return true; }
    json(response, 200, { ...card, canWrite: rights.write });
    return true;
  }
  if (request.method === 'PATCH') {
    if (!rights.write) { errorJson(response, 403, 'Карточку ТС правят механики и Ресурс (право fleet:write)'); return true; }
    const body = await readJson(request);
    const result = saveVehicleCard(db, rest, body || {}, user?.full_name || user?.username || '');
    if (!result.ok) { errorJson(response, result.status, result.error); return true; }
    audit(db, user, 'vehicle_card_update', 'vehicle', rest, { changes: result.changes }, requestIp(request));
    json(response, 200, { ...vehicleCard(db, rest, opts), canWrite: true });
    return true;
  }
  errorJson(response, 405, 'Метод не поддерживается');
  return true;
}
