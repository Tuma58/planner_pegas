// Текучесть водителей — KPI паспорта руководителя отдела эксплуатации
// (чек-лист продукта Б1.3, 07.11.2026).
//
// Формула: текучесть за период = уволено / средняя численность × 100.
// Средняя численность — среднесписочная по дням: сумма человеко-дней в
// списке за период / число дней периода (день увольнения ещё в списке).
//
// Откуда даты (своих колонок у drivers не было — их добавляет migrateTurnover):
//   · приём (hired_on): аудит «create driver» → иначе created_at записи;
//     записи первого дня справочника (сид 05.08 из карточек ТС) — «в штате
//     до начала учёта»: дата приёма неизвестна (hired_source='baseline'),
//     в численности с первого дня учёта, приёмом НЕ считаются;
//   · увольнение (fired_on): последний аудит «delete / merge-double /
//     update status=fired» без последующего восстановления → иначе
//     updated_at записи, но не раньше последней явки/закрепления.
// Не всякая запись «fired» — увольнение (урок ревизии 31.10 и чистки 11.10):
//   · duplicate — дубль справочника: слит (merge-double), причина/заметка
//     «дубль», либо тёзка по первым двум словам ФИО остался работать;
//   · phantom — запись без следа работы (ни явки, ни закрепления) и без
//     причины увольнения: устаревшая/ошибочная строка списка.
//   Оба вида исключены и из численности, и из уволенных — но видны в
//   ответе (excludedFired), чтобы руководитель мог поправить руками.
// Руками поправленные даты/вид (source='manual') синхронизация не трогает.
//
// Живые нормативы (CLAUDE.md): порог «короткого стажа» — из Настроек
// (settings.turnover.shortTenureDays, ноль — осознанное значение) или
// выучен из факта: медиана стажа уволенных с известным стажем при
// достаточном числе образцов (settings.turnover.minSamples, фолбэк 5 —
// как factPaymentDays в crm.mjs), в клампе [1 день; длина истории учёта].
// Нет ни того, ни другого — порог неизвестен, список пуст с пометкой.
// Цель текучести — settings.turnover.targetPct (если задана руководителем).

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
const META_KEY = 'driver_turnover_dates_v1';

export const FIRED_KIND_LABEL = { real: 'увольнение', duplicate: 'дубль записи', phantom: 'запись без работы' };

// ── Даты ──
const addDays = (day, days) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + Number(days) * DAY_MS).toISOString().slice(0, 10);
const daysBetween = (fromDay, toDay) =>
  Math.round((Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) / DAY_MS);
const minDay = (a, b) => (a <= b ? a : b);
const maxDay = (a, b) => (a >= b ? a : b);

// Отметка времени SQLite (UTC, 'YYYY-MM-DD HH:MM:SS' или ISO) → день в
// часовом поясе планирования.
export function dayIn(stamp, timeZone) {
  if (!stamp) return null;
  const text = String(stamp);
  if (DAY_RE.test(text)) return text;
  const ms = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(text) ? text : `${text.replace(' ', 'T')}Z`);
  if (!Number.isFinite(ms)) return text.slice(0, 10);
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timeZone || undefined,
      year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
  } catch { return new Date(ms).toISOString().slice(0, 10); }
}
export const todayIn = (timeZone, nowMs = Date.now()) => dayIn(new Date(nowMs).toISOString(), timeZone);

const normName = value => String(value || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
const firstTwo = value => normName(value).split(' ').slice(0, 2).join(' ');
const parse = text => { try { return JSON.parse(text || '{}') || {}; } catch { return {}; } };
const DUP_RE = /дубл/i;

function settingsOf(db) {
  const out = {};
  for (const row of db.prepare(`SELECT key,value_json FROM settings WHERE key IN ('general','turnover')`).all()) {
    out[row.key] = parse(row.value_json);
  }
  return out;
}

// ── Миграция ──
const COLUMNS = [['hired_on', 'TEXT'], ['fired_on', 'TEXT'], ['hired_source', 'TEXT'],
  ['fired_source', 'TEXT'], ['fired_kind', 'TEXT'], ['fired_reason', 'TEXT']];

export function migrateTurnover(db) {
  const have = new Set(db.prepare('PRAGMA table_info(drivers)').all().map(row => row.name));
  for (const [name, type] of COLUMNS) {
    if (!have.has(name)) db.exec(`ALTER TABLE drivers ADD COLUMN ${name} ${type}`);
  }
  const first = !db.prepare('SELECT 1 FROM app_meta WHERE key=?').get(META_KEY);
  const summary = syncTurnoverDates(db);
  // Разовая разметка истории — с меткой и итогом (отчёт о дрейфе по п.5).
  if (first) {
    db.prepare('INSERT OR IGNORE INTO app_meta(key,value) VALUES(?,?)')
      .run(META_KEY, JSON.stringify({ at: new Date().toISOString(), ...summary }));
    console.log(`migrateTurnover: даты приёма/увольнения размечены · ${JSON.stringify(summary)}`);
  }
  return summary;
}

// Аудит водителей: живой журнал + архив ночного переноса (если есть).
function driverEvents(db) {
  const hasArchive = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='audit_log_archive'`).get();
  const select = table => `SELECT entity_id, action, details_json, created_at FROM ${table}
    WHERE entity='driver' AND entity_id IS NOT NULL
      AND (action IN ('create','delete','restore','merge-double')
        OR (action='update' AND details_json LIKE '%"status"%'))`;
  const rows = db.prepare(hasArchive ? `${select('audit_log')} UNION ALL ${select('audit_log_archive')}` : select('audit_log')).all();
  const byDriver = new Map();
  for (const row of rows) {
    if (!byDriver.has(row.entity_id)) byDriver.set(row.entity_id, []);
    byDriver.get(row.entity_id).push({ ...row, details: parse(row.details_json) });
  }
  for (const list of byDriver.values()) list.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  return byDriver;
}

// Первый день справочника водителей: начало учёта. Руководитель может
// задать его явно (settings.turnover.accountingFrom), иначе — из факта.
export function accountingStart(db, settings = settingsOf(db)) {
  const tz = settings.general?.timezone;
  const set = settings.turnover?.accountingFrom;
  if (DAY_RE.test(set || '')) return { day: set, source: 'settings' };
  const first = db.prepare('SELECT MIN(created_at) m FROM drivers').get()?.m;
  return { day: first ? dayIn(first, tz) : null, source: first ? 'fact' : 'none' };
}

const fireEvent = ev => ev.action === 'delete' || ev.action === 'merge-double'
  || (ev.action === 'update' && ev.details.status === 'fired');
const unfireEvent = ev => ev.action === 'restore'
  || (ev.action === 'update' && ev.details.status && ev.details.status !== 'fired');

// Инкрементальная разметка: каждый вызов приводит колонки в соответствие
// фактам (новые приёмы/увольнения/восстановления), ручное не трогает.
export function syncTurnoverDates(db) {
  const settings = settingsOf(db);
  const tz = settings.general?.timezone;
  const start = accountingStart(db, settings).day;
  const events = driverEvents(db);
  const drivers = db.prepare('SELECT * FROM drivers').all();
  const lastWork = new Map();
  for (const row of db.prepare(`SELECT driver_id id, MAX(day) d FROM driver_attendance
    WHERE status='present' GROUP BY driver_id`).all()) lastWork.set(row.id, row.d);
  for (const row of db.prepare(`SELECT driver_id id, MAX(substr(starts_at,1,10)) d FROM driver_assignments
    GROUP BY driver_id`).all()) {
    if (!lastWork.has(row.id) || row.d > lastWork.get(row.id)) lastWork.set(row.id, row.d);
  }
  const summary = { accountingFrom: start, hiredAudit: 0, hiredCreated: 0, baseline: 0, manual: 0,
    fired: { real: 0, duplicate: 0, phantom: 0 }, changed: 0 };
  const update = db.prepare(`UPDATE drivers SET hired_on=?, hired_source=?, fired_on=?, fired_source=?,
    fired_kind=?, fired_reason=? WHERE id=?`);
  const plan = [];
  for (const driver of drivers) {
    const list = events.get(driver.id) || [];
    let hiredOn = driver.hired_on;
    let hiredSource = driver.hired_source;
    if (hiredSource !== 'manual') {
      const created = list.find(ev => ev.action === 'create');
      const createdDay = dayIn(driver.created_at, tz);
      const day = created ? dayIn(created.created_at, tz) : createdDay;
      // Заведён не позже начала учёта — «в штате до учёта» (наполнение
      // справочника, а не приём). Начало учёта руководитель может сдвинуть.
      if (start && day && day <= start) { hiredOn = null; hiredSource = 'baseline'; }
      else { hiredOn = day; hiredSource = created ? 'audit' : 'created'; }
    }
    let firedOn = null, firedSource = null, firedKind = null, firedReason = null;
    if (driver.status === 'fired') {
      if (driver.fired_source === 'manual') {
        firedOn = driver.fired_on; firedSource = 'manual'; firedKind = driver.fired_kind; firedReason = driver.fired_reason;
      } else {
        // Последнее увольнение, после которого не было восстановления.
        let fire = null;
        for (const ev of list) { if (fireEvent(ev)) fire = ev; else if (unfireEvent(ev)) fire = null; }
        const worked = lastWork.get(driver.id) || null;
        if (fire) { firedOn = dayIn(fire.created_at, tz); firedSource = 'audit'; }
        else { firedOn = dayIn(driver.updated_at, tz); firedSource = 'updated'; }
        if (worked && firedOn && worked > firedOn) { firedOn = worked; firedSource = 'attendance'; }
        firedReason = String(fire?.details?.reason || fire?.details?.note || '').trim();
        const twin = drivers.some(other => other.id !== driver.id && firstTwo(other.full_name) === firstTwo(driver.full_name)
          && (other.status !== 'fired' || String(other.created_at) > String(driver.created_at)));
        if (fire?.action === 'merge-double' || DUP_RE.test(firedReason) || DUP_RE.test(driver.note || '') || twin) firedKind = 'duplicate';
        else if (firedReason) firedKind = 'real';
        else if (!worked) firedKind = 'phantom';
        else firedKind = 'real';
      }
      if (firedKind) summary.fired[firedKind] = (summary.fired[firedKind] || 0) + 1;
    }
    if (hiredSource === 'audit') summary.hiredAudit += 1;
    else if (hiredSource === 'created') summary.hiredCreated += 1;
    else if (hiredSource === 'baseline') summary.baseline += 1;
    else if (hiredSource === 'manual') summary.manual += 1;
    const next = [hiredOn ?? null, hiredSource ?? null, firedOn, firedSource, firedKind, firedReason];
    const prev = [driver.hired_on ?? null, driver.hired_source ?? null, driver.fired_on ?? null,
      driver.fired_source ?? null, driver.fired_kind ?? null, driver.fired_reason ?? null];
    if (next.some((value, index) => value !== prev[index])) plan.push([...next, driver.id]);
  }
  if (plan.length) {
    db.exec('BEGIN IMMEDIATE');
    try { for (const args of plan) update.run(...args); db.exec('COMMIT'); }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  summary.changed = plan.length;
  return summary;
}

// ── Расчёт ──
export function median(values) {
  const list = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!list.length) return null;
  const mid = Math.floor(list.length / 2);
  return list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
}
const round1 = value => Math.round(value * 10) / 10;

// Порог короткого стажа: Настройки → выучен (медиана) → неизвестен.
export function shortTenureThreshold(tenures, settings = {}, historyDays = null) {
  const set = settings.turnover?.shortTenureDays;
  if (set !== undefined && set !== null && set !== '' && Number.isFinite(Number(set)) && Number(set) >= 0) {
    return { days: Number(set), source: 'settings', samples: tenures.length };
  }
  const minRaw = settings.turnover?.minSamples;
  const minSamples = minRaw !== undefined && minRaw !== null && minRaw !== '' && Number.isFinite(Number(minRaw)) ? Number(minRaw) : 5;
  if (tenures.length < minSamples || !tenures.length) {
    return { days: null, source: 'none', samples: tenures.length, minSamples, note: `мало образцов (${tenures.length} из ${minSamples})` };
  }
  const learned = median(tenures);
  const hi = Number.isFinite(historyDays) && historyDays >= 1 ? historyDays : learned;
  const days = Math.round(Math.min(Math.max(learned, 1), hi));
  return { days, source: 'learned', samples: tenures.length, minSamples, learned,
    clamped: days !== Math.round(learned) };
}

function employment(row, start) {
  const kind = row.status === 'fired' ? row.fired_kind : null;
  if (kind === 'duplicate' || kind === 'phantom') return null;
  const from = row.hired_on || start;
  if (!from) return null;
  const to = row.status === 'fired' ? (row.fired_on || null) : null;
  return { from, to };
}

function periodStats(rows, start, from, to) {
  const days = daysBetween(from, to) + 1;
  let manDays = 0, hired = 0, fired = 0;
  for (const row of rows) {
    const span = employment(row, start);
    if (!span) continue;
    const a = maxDay(span.from, from);
    const b = span.to ? minDay(span.to, to) : to;
    if (b >= a) manDays += daysBetween(a, b) + 1;
    if (row.hired_source !== 'baseline' && row.hired_on && row.hired_on >= from && row.hired_on <= to) hired += 1;
    if (row.status === 'fired' && row.fired_kind === 'real' && row.fired_on >= from && row.fired_on <= to) fired += 1;
  }
  const headcountAvg = days > 0 ? round1(manDays / days) : 0;
  return { from, to, days, headcountAvg, hired, fired,
    turnoverPct: headcountAvg > 0 ? round1(fired / headcountAvg * 100) : null };
}

function tenureOf(row, start) {
  if (!row.fired_on) return { tenureDays: null, tenureKnown: false };
  if (row.hired_on && row.hired_source !== 'baseline') {
    return { tenureDays: Math.max(0, daysBetween(row.hired_on, row.fired_on)), tenureKnown: true };
  }
  // В штате до учёта: известна только нижняя граница стажа.
  return { tenureDays: start ? Math.max(0, daysBetween(start, row.fired_on)) : null, tenureKnown: false };
}

export function driverTurnover(db, { from = '', to = '', today = '', sync = true } = {}) {
  if (sync) syncTurnoverDates(db);
  const settings = settingsOf(db);
  const tz = settings.general?.timezone;
  const now = DAY_RE.test(today) ? today : todayIn(tz);
  const toDay = DAY_RE.test(to) ? to : now;
  const fromDay = DAY_RE.test(from) ? from : `${toDay.slice(0, 4)}-01-01`;
  if (fromDay > toDay) throw Object.assign(new Error('Период задан неверно'), { status: 422 });
  const acc = accountingStart(db, settings);
  const start = acc.day;
  const rows = db.prepare(`SELECT id, full_name, status, note, hired_on, hired_source, fired_on, fired_source,
    fired_kind, fired_reason FROM drivers`).all();
  const target = Number.isFinite(Number(settings.turnover?.targetPct)) && settings.turnover?.targetPct !== null
    && settings.turnover?.targetPct !== '' && settings.turnover?.targetPct !== undefined
    ? Number(settings.turnover.targetPct) : null;
  const base = { from: fromDay, to: toDay, today: now, accountingFrom: start, accountingSource: acc.source, targetPct: target };
  const effFrom = start ? maxDay(fromDay, start) : null;
  if (!effFrom || effFrom > toDay) {
    return { ...base, coverageFrom: null, headcountAvg: 0, hired: 0, fired: 0, turnoverPct: null, byMonth: [],
      recentFired: [], shortTenure: [], excludedFired: [], threshold: { days: null, source: 'none', samples: 0 },
      note: 'период раньше начала учёта водителей' };
  }
  const total = periodStats(rows, start, effFrom, toDay);
  const byMonth = [];
  for (let month = effFrom.slice(0, 7); month <= toDay.slice(0, 7);) {
    const mFrom = maxDay(`${month}-01`, effFrom);
    const next = addDays(`${month}-01`, 32).slice(0, 7);
    const mTo = minDay(addDays(`${next}-01`, -1), toDay);
    byMonth.push({ month, ...periodStats(rows, start, mFrom, mTo) });
    month = next;
  }
  const realFired = rows.filter(row => row.status === 'fired' && row.fired_kind === 'real' && row.fired_on)
    .map(row => ({ id: row.id, name: row.full_name, firedOn: row.fired_on, hiredOn: row.hired_source === 'baseline' ? null : row.hired_on,
      reason: row.fired_reason || '', source: row.fired_source, ...tenureOf(row, start) }));
  const historyDays = daysBetween(start, now) + 1;
  const threshold = shortTenureThreshold(realFired.filter(row => row.tenureKnown).map(row => row.tenureDays), settings, historyDays);
  const inPeriod = row => row.firedOn >= effFrom && row.firedOn <= toDay;
  const recentFired = realFired.filter(inPeriod).sort((a, b) => b.firedOn.localeCompare(a.firedOn));
  const shortTenure = threshold.days === null ? []
    : recentFired.filter(row => row.tenureKnown && row.tenureDays < threshold.days);
  const excludedFired = rows.filter(row => row.status === 'fired' && row.fired_kind !== 'real'
      && row.fired_on >= effFrom && row.fired_on <= toDay)
    .map(row => ({ id: row.id, name: row.full_name, firedOn: row.fired_on, kind: row.fired_kind,
      kindLabel: FIRED_KIND_LABEL[row.fired_kind] || row.fired_kind, reason: row.fired_reason || '' }))
    .sort((a, b) => b.firedOn.localeCompare(a.firedOn));
  return { ...base, coverageFrom: effFrom, ...total, byMonth, recentFired, shortTenure,
    shortTenureShare: recentFired.length ? round1(shortTenure.length / recentFired.length * 100) : null,
    threshold, excludedFired,
    active: rows.filter(row => row.status !== 'fired').length,
    note: effFrom > fromDay ? `учёт водителей ведётся с ${effFrom.split('-').reverse().join('.')}` : '' };
}

// ── Права ──
export function turnoverRights({ user, access, hasPermission }) {
  if (!user) return { read: false, write: false };
  const legacy = !access || access.legacy;
  const views = access?.views || [];
  const scope = access?.scope || {};
  const read = legacy
    ? hasPermission(user, 'staff:write') || hasPermission(user, 'reports:read')
    : (views.includes('resource') || views.includes('field')) && Boolean(scope.all || scope.depts?.includes('drv'));
  const write = read && (hasPermission(user, 'staff:write') || hasPermission(user, 'fleet:write') || hasPermission(user, 'users:write'));
  return { read, write };
}

// Ручная поправка: дата приёма из кадров для «в штате до учёта», дата
// увольнения или вид записи. Пустое значение возвращает автоматику.
export function correctionFromBody(body = {}) {
  const out = {};
  if ('hiredOn' in body) out.hiredOn = body.hiredOn ? String(body.hiredOn) : null;
  if ('firedOn' in body) out.firedOn = body.firedOn ? String(body.firedOn) : null;
  if ('kind' in body) out.kind = body.kind ? String(body.kind) : null;
  if ('reason' in body) out.reason = String(body.reason || '').trim().slice(0, 300);
  return out;
}
export function correctionError(fix) {
  if (fix.hiredOn && !DAY_RE.test(fix.hiredOn)) return 'Дата приёма — в формате ГГГГ-ММ-ДД';
  if (fix.firedOn && !DAY_RE.test(fix.firedOn)) return 'Дата увольнения — в формате ГГГГ-ММ-ДД';
  if (fix.kind && !FIRED_KIND_LABEL[fix.kind]) return 'Вид записи: real, duplicate или phantom';
  if (fix.hiredOn && fix.firedOn && fix.firedOn < fix.hiredOn) return 'Увольнение раньше приёма';
  return '';
}

export async function turnoverApi(ctx) {
  const { db, request, response, url, pathname, user, json, errorJson, readJson, audit, requestIp } = ctx;
  if (pathname !== '/api/turnover' && !pathname.startsWith('/api/turnover/')) return false;
  if (!user) { errorJson(response, 401, 'Требуется вход'); return true; }
  const rights = turnoverRights(ctx);
  if (!rights.read) { errorJson(response, 403, 'Текучесть водителей — у руководителя эксплуатации и Ресурса'); return true; }
  const method = request.method;
  if (pathname === '/api/turnover' && method === 'GET') {
    try {
      json(response, 200, { canWrite: rights.write, ...driverTurnover(db, {
        from: String(url.searchParams.get('from') || '').slice(0, 10),
        to: String(url.searchParams.get('to') || '').slice(0, 10) }) });
    } catch (error) {
      if (error.status) errorJson(response, error.status, error.message); else throw error;
    }
    return true;
  }
  const match = /^\/api\/turnover\/drivers\/([^/]+)$/.exec(pathname);
  if (match && method === 'PATCH') {
    if (!rights.write) { errorJson(response, 403, 'Править даты может Ресурс или кадры'); return true; }
    const driver = db.prepare('SELECT * FROM drivers WHERE id=?').get(decodeURIComponent(match[1]));
    if (!driver) { errorJson(response, 404, 'Водитель не найден'); return true; }
    const fix = correctionFromBody(await readJson(request));
    const error = correctionError({ hiredOn: fix.hiredOn ?? driver.hired_on, firedOn: fix.firedOn ?? driver.fired_on, kind: fix.kind });
    if (error) { errorJson(response, 422, error); return true; }
    if (('firedOn' in fix || 'kind' in fix) && driver.status !== 'fired') {
      errorJson(response, 422, 'Водитель в штате — увольнение оформляется в справочнике'); return true;
    }
    if ('hiredOn' in fix) {
      db.prepare('UPDATE drivers SET hired_on=?, hired_source=? WHERE id=?')
        .run(fix.hiredOn, fix.hiredOn ? 'manual' : null, driver.id);
    }
    if ('firedOn' in fix || 'kind' in fix || 'reason' in fix) {
      // Пустые дата и вид разом — «вернуть автоматику»; иначе запись ручная.
      const manual = Boolean(fix.firedOn || fix.kind || ('reason' in fix && !('firedOn' in fix) && !('kind' in fix)));
      db.prepare('UPDATE drivers SET fired_on=?, fired_kind=?, fired_reason=?, fired_source=? WHERE id=?')
        .run(fix.firedOn ?? driver.fired_on, fix.kind ?? driver.fired_kind ?? 'real',
          fix.reason ?? driver.fired_reason ?? '', manual ? 'manual' : null, driver.id);
    }
    syncTurnoverDates(db); // пустые поля вернулись к автоматике
    audit(db, user, 'turnover-fix', 'driver', driver.id, fix, requestIp(request));
    json(response, 200, { ok: true });
    return true;
  }
  return false;
}
