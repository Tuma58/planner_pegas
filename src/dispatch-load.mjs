import { settingsObject } from './db.mjs';
import { crewNorms } from './crew-fund.mjs';

// Живые лимиты диспетчерской (канбан, этап 2, 11.10, заказ руководителя).
// ЛИЧНАЯ ЁМКОСТЬ смены выучивается из факта: медиана отметок контроля
// (task_marks kind='dispatcher', без claim-захватов) за рабочий день по
// человеку за 14 дней, минимум 3 дня с отметками. Фолбэк для новичка —
// медиана по коллегам (а до первых фактов вообще — стартовые 15, они
// уходят с первым же пересчётом по факту). Кламп здравого смысла 5–60.
// Пересчёт — раз в сутки сторожем, снимок и дрейф — в app_meta
// dispatcher_capacity (канон живых нормативов: факт → норматив → отчёт
// о дрейфе).

const median = list => {
  const sorted = [...list].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
};
const CAP_MIN = 5;
const CAP_MAX = 60;
const CAP_START = 15; // стартовый фолбэк до первых фактов
const clampCap = value => Math.min(CAP_MAX, Math.max(CAP_MIN, Math.round(value)));

const metaGet = (db, key) => db.prepare('SELECT value FROM app_meta WHERE key=?').get(key)?.value;
const metaSet = (db, key, value) => db.prepare(`INSERT INTO app_meta(key,value) VALUES(?,?)
  ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, value);

export function rebuildDispatcherCapacity(db, nowIso = new Date().toISOString()) {
  const day = nowIso.slice(0, 10);
  const rows = db.prepare(`SELECT done_by name, day, COUNT(*) n FROM task_marks
    WHERE kind='dispatcher' AND day >= date(?, '-14 day') AND day < ?
      AND done_by <> '' AND item_key NOT LIKE 'claim|%'
    GROUP BY done_by, day`).all(day, day);
  const daysByName = new Map();
  for (const row of rows) {
    if (!daysByName.has(row.name)) daysByName.set(row.name, []);
    daysByName.get(row.name).push(row.n);
  }
  const caps = {};
  const learned = [];
  for (const [name, days] of daysByName) {
    if (days.length < 3) continue; // мало образцов — человек на фолбэке
    const cap = clampCap(median(days));
    caps[name] = cap;
    learned.push(cap);
  }
  const allDays = rows.map(row => row.n);
  const fallback = learned.length ? clampCap(median(learned))
    : allDays.length ? clampCap(median(allDays)) : CAP_START;
  let prev = null;
  try { prev = JSON.parse(metaGet(db, 'dispatcher_capacity') || 'null'); } catch { prev = null; }
  const snapshot = { at: nowIso, caps, fallback,
    samples: { people: daysByName.size, learned: learned.length, markDays: rows.length } };
  metaSet(db, 'dispatcher_capacity', JSON.stringify(snapshot));
  const drift = [];
  for (const [name, cap] of Object.entries(caps)) {
    const was = prev?.caps?.[name];
    if (was != null && was !== cap) drift.push(`${name}: ${was}→${cap}`);
  }
  return { snapshot, prev, drift };
}

// Текущая загрузка смены: сегодняшние отметки по людям против личной
// ёмкости; «в смене» — по графику смен офиса (day/night) плюс все, кто
// уже отмечал сегодня. dispatcherRole=false у ведущего контроль не-
// диспетчера (кейс «логист тянет контроль» — аномалия, видная сразу).
export function dispatcherShiftLoad(db, nowIso = new Date().toISOString()) {
  let snap = null;
  try { snap = JSON.parse(metaGet(db, 'dispatcher_capacity') || 'null'); } catch { snap = null; }
  if (!snap) snap = rebuildDispatcherCapacity(db, nowIso).snapshot;
  const day = nowIso.slice(0, 10);
  const today = new Map(db.prepare(`SELECT done_by name, COUNT(*) n FROM task_marks
    WHERE kind='dispatcher' AND day=? AND done_by <> '' AND item_key NOT LIKE 'claim|%'
    GROUP BY done_by`).all(day).map(row => [row.name, row.n]));
  const people = new Map();
  for (const row of db.prepare(`SELECT u.full_name name, u.role, COALESCE(u.roles,'') roles,
      COALESCE(u.dispatch_exempt, 0) exempt
      FROM staff_shifts s JOIN users u ON u.id=s.user_id
      WHERE s.day=? AND s.kind IN ('day','night') AND u.active=1`).all(day)) {
    if (row.exempt) continue; // руководитель службы и т.п. — вне распределения
    people.set(row.name, { name: row.name, onShift: true,
      dispatcherRole: row.role === 'dispatcher' || row.role === 'admin'
        || row.roles.includes('dispatcher') });
  }
  for (const name of today.keys()) {
    if (!people.has(name)) {
      const user = db.prepare(`SELECT role, COALESCE(roles,'') roles,
        COALESCE(dispatch_exempt, 0) exempt FROM users
        WHERE full_name=? AND active=1`).get(name);
      if (user?.exempt) continue;
      people.set(name, { name, onShift: false,
        dispatcherRole: !user ? false : user.role === 'dispatcher' || user.role === 'admin'
          || user.roles.includes('dispatcher') });
    }
  }
  const list = [...people.values()].map(person => ({
    ...person,
    today: today.get(person.name) || 0,
    cap: snap.caps?.[person.name] ?? snap.fallback
  })).filter(person => person.today > 0 || (person.onShift && person.dispatcherRole))
    .sort((a, b) => b.today - a.today);
  return { people: list, fallback: snap.fallback, capAt: snap.at };
}

// ── Этап 3б: авторазвод смены (решение руководителя 11.10) ──────────
// Профили нагрузки по часам МСК учатся из СОБЫТИЙ рейсов за 28 дней
// (не из отметок — отметки били задним числом): подготовка наплывами,
// выгрузки и вопросы волнами; контроль в пути считается от живых
// карточек (ровный поток). Балансировщик непрерывно назначает карточки
// доски конкретным людям (липко: взятое остаётся у владельца, manual
// неприкосновенен), план часа снимается в dispatch_plan_hours — отчёт
// «план/факт за смену» кормит самообучение.

const MSK_MS = 3 * 3.6e6;
const hourMsk = iso => {
  const ms = Date.parse(String(iso).replace(' ', 'T') + (String(iso).includes('Z') || String(iso).includes('+') ? '' : 'Z'));
  return Math.floor(((ms + MSK_MS) % 864e5) / 3.6e6);
};

export function rebuildDispatchProfiles(db, nowIso = new Date().toISOString()) {
  const day = nowIso.slice(0, 10);
  const since = new Date(Date.parse(day + 'T00:00:00Z') - 28 * 864e5).toISOString();
  const byHourDay = () => Array.from({ length: 24 }, () => new Map());
  const buckets = { prep: byHourDay(), unload: byHourDay(), questions: byHourDay() };
  const bump = (kind, iso) => {
    if (!iso) return;
    const h = hourMsk(iso);
    const d = String(iso).slice(0, 10);
    const slot = buckets[kind][h];
    slot.set(d, (slot.get(d) || 0) + 1);
  };
  for (const col of ['logist_confirmed_at', 'entered_1c_at', 'driver_notified_at', 'on_line_at']) {
    for (const r of db.prepare(`SELECT ${col} t FROM trips WHERE ${col} >= ? AND ${col} < ?`)
      .all(since, day)) bump('prep', r.t);
  }
  for (const r of db.prepare(`SELECT actual_arrival t FROM trip_stops
      WHERE kind='D' AND actual_arrival >= ? AND actual_arrival < ?`).all(since, day)) {
    bump('unload', r.t);
  }
  for (const r of db.prepare(`SELECT unloaded_at t FROM trips
      WHERE unloaded_at >= ? AND unloaded_at < ?`).all(since, day)) bump('unload', r.t);
  for (const r of db.prepare(`SELECT opened_at t FROM driver_questions
      WHERE opened_at >= ? AND opened_at < ?`).all(since.replace('T', ' ').slice(0, 19),
    day + ' 00:00:00')) bump('questions', r.t);
  const median = list => { const l = [...list].sort((a, b) => a - b);
    return l.length ? l[Math.floor(l.length / 2)] : 0; };
  const profile = kind => buckets[kind].map(slot => median([...slot.values()]));
  const snapshot = { at: nowIso,
    prep: profile('prep'), unload: profile('unload'), questions: profile('questions') };
  metaSet(db, 'dispatch_profiles', JSON.stringify(snapshot));
  return snapshot;
}

// Активные карточки доски с колонкой — та же раскладка, что на экране.
// Времена шагов нужны эскалации (3в): от них считается «вход в колонку».
export function boardCards(db) {
  const cards = [];
  for (const t of db.prepare(`SELECT t.id, t.status, t.logist_confirmed_at, t.on_line_at,
      t.entered_1c_at, t.driver_notified_at, t.created_at, t.starts_at,
      (SELECT v.plate FROM vehicles v WHERE v.id=t.vehicle_id) plate,
      (SELECT MIN(s.actual_departure) FROM trip_stops s
        WHERE s.trip_id=t.id AND s.kind='P' AND s.actual_departure IS NOT NULL) dep,
      (SELECT MAX(s.actual_arrival) FROM trip_stops s
        WHERE s.trip_id=t.id AND s.kind='D' AND s.actual_arrival IS NOT NULL) arr_d
    FROM trips t WHERE t.status IN ('plan','run')`).all()) {
    const col = t.status === 'plan' ? 'prep'
      : !t.dep ? 'load' : t.arr_d ? 'unload' : 'road';
    cards.push({ tripId: t.id, col, kind: 'trip', plate: t.plate || '',
      enteredAt: col === 'prep'
        ? [t.driver_notified_at, t.entered_1c_at, t.logist_confirmed_at, t.created_at]
          .find(Boolean) || null
        : col === 'load' ? (t.on_line_at || t.starts_at)
          : col === 'road' ? t.dep : t.arr_d });
  }
  // Перегоны порожним — такие же карточки с ответственным (заказ
  // руководителя 12.10: «там один шаг — позвонить и сообщить водителю»):
  // до выезда — в «Подготовке», после — «В пути»; прибыл — ушла с доски.
  for (const t of db.prepare(`SELECT d.id, d.starts_at, d.created_at,
      d.driver_notified_at, d.departed_at,
      (SELECT v.plate FROM vehicles v WHERE v.id=d.vehicle_id) plate
    FROM vehicle_dispositions d
    WHERE d.kind='transfer' AND d.arrived_at IS NULL`).all()) {
    cards.push({ tripId: t.id, col: t.departed_at ? 'road' : 'prep',
      kind: 'transfer', plate: t.plate || '',
      enteredAt: t.departed_at || t.driver_notified_at || t.created_at || t.starts_at });
  }
  return cards;
}

// Раздача — только тем, кто СЕГОДНЯ В СМЕНЕ по графику (уточнение
// руководителя 12.10: «на тех, кто на выходном, объёмы не
// распределять»). Активный в свой выходной виден в полосе, но карточек
// не получает. Фолбэк: график на день пуст — раздаём активным
// диспетчерам (переходный режим, пока табель не заполнен).
function shiftWorkers(people) {
  const onShift = people.filter(p => p.dispatcherRole && p.onShift);
  return onShift.length ? onShift : people.filter(p => p.dispatcherRole);
}

export function assignBoardCards(db, nowIso = new Date().toISOString()) {
  const { people } = dispatcherShiftLoad(db, nowIso);
  const workers = shiftWorkers(people);
  const cards = boardCards(db);
  const activeIds = new Set(cards.map(c => c.tripId));
  // Чистка: назначения закрытых/снятых рейсов уходят.
  for (const row of db.prepare(`SELECT trip_id FROM dispatch_assignments`).all()) {
    if (!activeIds.has(row.trip_id)) {
      db.prepare(`DELETE FROM dispatch_assignments WHERE trip_id=?`).run(row.trip_id);
    }
  }
  if (!workers.length) return { assigned: 0, total: cards.length };
  const current = new Map(db.prepare(`SELECT trip_id, name, source FROM dispatch_assignments`)
    .all().map(r => [r.trip_id, r]));
  const names = new Set(workers.map(w => w.name));
  const loadOf = new Map(workers.map(w => [w.name, 0]));
  for (const card of cards) {
    const own = current.get(card.tripId);
    if (own && (own.source === 'manual' || names.has(own.name))) {
      loadOf.set(own.name, (loadOf.get(own.name) || 0) + 1);
    }
  }
  // Эскалированные (3в) неприкосновенны, как manual: вернуть карточку
  // в общий пул может только сама эскалация, когда движение пошло.
  const sticky = own => own && (own.source === 'manual'
    || own.source.startsWith('esc_') || names.has(own.name));
  const put = db.prepare(`INSERT INTO dispatch_assignments(trip_id, name, source)
    VALUES(?,?, 'auto') ON CONFLICT(trip_id) DO UPDATE SET
    name=excluded.name, source='auto', assigned_at=CURRENT_TIMESTAMP`);
  let assigned = 0;
  for (const card of cards) {
    const own = current.get(card.tripId);
    if (sticky(own)) continue; // липкость
    // Наименее загруженный относительно личной ёмкости.
    const best = workers.reduce((a, b) =>
      (loadOf.get(a.name) / a.cap) <= (loadOf.get(b.name) / b.cap) ? a : b);
    put.run(card.tripId, best.name);
    loadOf.set(best.name, loadOf.get(best.name) + 1);
    assigned += 1;
  }
  return { assigned, total: cards.length };
}

// План часа: текущий объём карточек + прогноз наплывов из профилей,
// разложенные по присутствующим пропорционально ёмкостям, — то, что
// показывала симуляция, теперь снимается каждый час для «план/факт».
export function snapshotPlanHour(db, nowIso = new Date().toISOString()) {
  const day = nowIso.slice(0, 10);
  const hour = hourMsk(nowIso);
  let profiles = null;
  try { profiles = JSON.parse(metaGet(db, 'dispatch_profiles') || 'null'); } catch { profiles = null; }
  if (!profiles) profiles = rebuildDispatchProfiles(db, nowIso);
  const { people } = dispatcherShiftLoad(db, nowIso);
  const workers = shiftWorkers(people);
  const cards = boardCards(db);
  const road = cards.filter(c => c.col === 'road').length;
  const load = {
    road: +(road / 4).toFixed(1), // контролей в час при нормативе 4 ч
    prep: profiles.prep[hour] || 0,
    unload: profiles.unload[hour] || 0,
    questions: profiles.questions[hour] || 0
  };
  const capSum = workers.reduce((s, w) => s + w.cap, 0) || 1;
  const plan = {};
  for (const w of workers) {
    plan[w.name] = +((load.road + load.prep + load.unload + load.questions) * w.cap / capSum).toFixed(1);
  }
  db.prepare(`INSERT INTO dispatch_plan_hours(day, hour, payload) VALUES(?,?,?)
    ON CONFLICT(day, hour) DO UPDATE SET payload=excluded.payload`).run(
    day, hour, JSON.stringify({ at: nowIso, load, plan, present: workers.map(w => w.name) }));
  return { day, hour, load, plan };
}

// Отчёт «план/факт за смену»: план из почасовых снимков, факт — отметки
// контроля (task_marks) и шаги подготовки (audit dispatch_step) по часам.
export function shiftPlanFact(db, day) {
  const hoursRows = db.prepare(`SELECT hour, payload FROM dispatch_plan_hours
    WHERE day=? ORDER BY hour`).all(day);
  const factCtrl = Array.from({ length: 24 }, () => new Map());
  for (const r of db.prepare(`SELECT done_by name, done_at FROM task_marks
      WHERE kind='dispatcher' AND day=? AND item_key NOT LIKE 'claim|%'`).all(day)) {
    const slot = factCtrl[hourMsk(r.done_at + 'Z')];
    slot.set(r.name, (slot.get(r.name) || 0) + 1);
  }
  const factPrep = Array.from({ length: 24 }, () => new Map());
  const mskFrom = new Date(Date.parse(day + 'T00:00:00Z') - MSK_MS).toISOString().replace('T', ' ').slice(0, 19);
  const mskTo = new Date(Date.parse(day + 'T00:00:00Z') - MSK_MS + 864e5).toISOString().replace('T', ' ').slice(0, 19);
  for (const r of db.prepare(`SELECT u.full_name name, a.created_at FROM audit_log a
      JOIN users u ON u.id=a.user_id
      WHERE a.action='dispatch_step' AND a.created_at >= ? AND a.created_at < ?`)
    .all(mskFrom, mskTo)) {
    const slot = factPrep[hourMsk(r.created_at + 'Z')];
    slot.set(r.name, (slot.get(r.name) || 0) + 1);
  }
  const names = new Set();
  const hours = [];
  for (let h = 0; h < 24; h += 1) {
    let payload = null;
    const row = hoursRows.find(r => r.hour === h);
    try { payload = row ? JSON.parse(row.payload) : null; } catch { payload = null; }
    for (const n of Object.keys(payload?.plan || {})) names.add(n);
    for (const n of factCtrl[h].keys()) names.add(n);
    for (const n of factPrep[h].keys()) names.add(n);
    hours.push({ hour: h, plan: payload?.plan || null, load: payload?.load || null,
      factCtrl: Object.fromEntries(factCtrl[h]), factPrep: Object.fromEntries(factPrep[h]) });
  }
  return { day, people: [...names].sort(), hours };
}

// ── Этап 3в: эскалация просроченных карточек (решение руководителя 12.10)
// «На старшего смены объём не распределять — только сильно просроченные;
// после старшего карточка уходит руководителю диспетчерской службы».
// Карточка без движения дольше норматива колонки × множитель уходит
// старшему смены, ещё N минут тишины — руководителю службы. Нормативы
// живые: подготовка — медиана lead за 28 дней (кламп 2–48 ч, фолбэк 24),
// погрузка/выгрузка — живые ворота gateNormH, «в пути» — интервал
// промежуточного контроля из настроек. Множитель и минуты — настройки
// (цели руководителя), ноль множителя — осознанное «выключено».

const parseTsMs = value => {
  if (!value) return NaN;
  const s = String(value).replace(' ', 'T');
  return Date.parse(s + (s.includes('Z') || s.includes('+') ? '' : 'Z'));
};

export function escalationSettings(db) {
  const raw = settingsObject(db).dispatch || {};
  return {
    factor: raw.escalateFactor === 0 ? 0 : Number(raw.escalateFactor ?? 2),
    headMin: raw.escalateHeadMin === 0 ? 0 : Number(raw.escalateHeadMin ?? 60),
    // Предохранитель (урок первого прогона 12.10: 56 карточек залпом):
    // за проход поднимаются только самые горящие, остальные — очередью.
    maxPerTick: raw.escalateMaxPerTick === 0 ? 0 : Number(raw.escalateMaxPerTick ?? 5)
  };
}

// Нормативы шага по колонкам: подготовка учится из факта раз в сутки
// (медиана logist_confirmed→on_line за 28 дней), остальные берутся из
// уже живых контуров — воро́та gateNormH и интервал контроля в пути.
export function boardStepNorms(db, nowIso = new Date().toISOString()) {
  const day = nowIso.slice(0, 10);
  let cached = null;
  try { cached = JSON.parse(metaGet(db, 'dispatch_step_norms') || 'null'); } catch { cached = null; }
  if (!cached || cached.day !== day) {
    const since = new Date(Date.parse(day + 'T00:00:00Z') - 28 * 864e5).toISOString();
    const hoursList = db.prepare(`SELECT logist_confirmed_at a, on_line_at b FROM trips
        WHERE logist_confirmed_at IS NOT NULL AND on_line_at IS NOT NULL
          AND on_line_at >= ? AND on_line_at < ?`).all(since, day)
      .map(r => (parseTsMs(r.b) - parseTsMs(r.a)) / 3.6e6)
      .filter(h => Number.isFinite(h) && h > 0);
    const med = median(hoursList);
    const prepH = med == null ? 24 : Math.min(48, Math.max(2, med));
    const was = cached?.prepH;
    cached = { day, prepH, samples: hoursList.length };
    metaSet(db, 'dispatch_step_norms', JSON.stringify(cached));
    if (was != null && Math.abs(was - prepH) >= 1) {
      console.log(`норматив подготовки доски: ${was.toFixed(1)}→${prepH.toFixed(1)} ч (образцов ${hoursList.length})`);
    }
  }
  const gateH = crewNorms(db).gateNormH;
  const midH = Number(settingsObject(db).calculation?.midControlHours ?? 4) || 4;
  return { prep: cached.prepH, load: gateH, road: midH, unload: gateH };
}

// Кто принимает эскалацию. Старшие смены — сменные сотрудники с должностью
// со словом «старший» (их может быть несколько — Базуев и Филюнина;
// вне обычной раздачи их держит dispatch_exempt); руководитель службы —
// должность «руководитель … диспетчерской». LOWER кириллицы SQLite не
// умеет — фильтр в JS.
export function escalationStaff(db, nowIso = new Date().toISOString()) {
  const day = nowIso.slice(0, 10);
  const lc = v => String(v || '').toLowerCase();
  const onShift = db.prepare(`SELECT u.full_name name, COALESCE(u.job_role,'') job
    FROM staff_shifts s JOIN users u ON u.id=s.user_id
    WHERE s.day=? AND s.kind IN ('day','night') AND u.active=1`).all(day);
  const seniors = onShift.filter(p => lc(p.job).includes('старш')).map(p => p.name);
  const head = db.prepare(`SELECT full_name name, COALESCE(job_role,'') job FROM users
      WHERE active=1 AND deleted_at IS NULL AND COALESCE(job_role,'')<>''`).all()
    .find(p => lc(p.job).includes('руковод') && lc(p.job).includes('диспетчер'))?.name || null;
  return { seniors, senior: seniors[0] || null, head };
}

// Последнее движение по карточке: вход в колонку, свежая отметка контроля
// (item_key начинается с id рейса) или шаг в аудите (у перегона — свой).
function lastActivityMs(db, card) {
  const stamps = [parseTsMs(card.enteredAt)];
  const mark = db.prepare(`SELECT MAX(done_at) t FROM task_marks
    WHERE kind='dispatcher' AND item_key LIKE ? || '|%'`).get(card.tripId)?.t;
  if (mark) stamps.push(parseTsMs(mark));
  const step = db.prepare(`SELECT MAX(created_at) t FROM audit_log
    WHERE action=? AND entity_id=?`)
    .get(card.kind === 'transfer' ? 'transfer_step' : 'dispatch_step', card.tripId)?.t;
  if (step) stamps.push(parseTsMs(step));
  const known = stamps.filter(Number.isFinite);
  return known.length ? Math.max(...known) : NaN;
}

export function escalateOverdueCards(db, nowIso = new Date().toISOString()) {
  const cfg = escalationSettings(db);
  if (!cfg.factor) return { escalated: [], released: [], seniors: [], head: null };
  const norms = boardStepNorms(db, nowIso);
  const { seniors, head } = escalationStaff(db, nowIso);
  const nowMs = Date.parse(nowIso);
  const current = new Map(db.prepare(`SELECT trip_id, name, source, assigned_at
    FROM dispatch_assignments`).all().map(r => [r.trip_id, r]));
  // Старших может быть несколько — эскалации раскладываются по наименее
  // нагруженному (считая уже висящие на них эскалированные карточки).
  const seniorLoad = new Map(seniors.map(n => [n, 0]));
  for (const r of current.values()) {
    if (r.source === 'esc_senior' && seniorLoad.has(r.name)) {
      seniorLoad.set(r.name, seniorLoad.get(r.name) + 1);
    }
  }
  const pickSenior = () => seniors.reduce((a, b) =>
    (a == null || seniorLoad.get(b) < seniorLoad.get(a)) ? b : a, null);
  const put = db.prepare(`INSERT INTO dispatch_assignments(trip_id, name, source)
    VALUES(?,?,?) ON CONFLICT(trip_id) DO UPDATE SET
    name=excluded.name, source=excluded.source, assigned_at=CURRENT_TIMESTAMP`);
  const escalated = [];
  const released = [];
  const candidates = [];
  for (const card of boardCards(db)) {
    const normH = norms[card.col];
    if (!Number.isFinite(normH) || normH <= 0) continue;
    const lastMs = lastActivityMs(db, card);
    if (!Number.isFinite(lastMs)) continue; // времени нет — судить не по чему
    const idleH = (nowMs - lastMs) / 3.6e6;
    const overdue = idleH > normH * cfg.factor;
    const own = current.get(card.tripId);
    if (own && own.source.startsWith('esc_')) {
      if (!overdue) {
        // Движение пошло — карточка возвращается в общий пул смены.
        put.run(card.tripId, own.name, 'auto');
        released.push({ tripId: card.tripId, plate: card.plate });
      } else if (own.source === 'esc_senior' && head && cfg.headMin
        && nowMs - parseTsMs(own.assigned_at) > cfg.headMin * 60_000) {
        put.run(card.tripId, head, 'esc_head');
        escalated.push({ level: 2, tripId: card.tripId, plate: card.plate,
          col: card.col, name: head, idleH, normH, from: own.name });
      }
      continue;
    }
    if (!overdue) continue;
    candidates.push({ card, own, idleH, normH, severity: idleH / normH });
  }
  // Предохранитель: только самые горящие за проход (остальные — очередью
  // следующих тиков). Без него первый запуск поднял 56 карточек залпом.
  candidates.sort((a, b) => b.severity - a.severity);
  for (const item of candidates.slice(0, cfg.maxPerTick)) {
    const { card, own, idleH, normH } = item;
    // Нет старших в смене — карточка уходит сразу руководителю службы.
    const seniorPick = pickSenior();
    const target = seniorPick ? { name: seniorPick, source: 'esc_senior' }
      : head ? { name: head, source: 'esc_head' } : null;
    if (!target || (own && own.name === target.name)) continue;
    put.run(card.tripId, target.name, target.source);
    if (target.source === 'esc_senior') {
      seniorLoad.set(target.name, seniorLoad.get(target.name) + 1);
    }
    escalated.push({ level: target.source === 'esc_senior' ? 1 : 2,
      tripId: card.tripId, plate: card.plate, col: card.col,
      name: target.name, idleH, normH, from: own?.name || '' });
  }
  return { escalated, released, seniors, head, queued: Math.max(0, candidates.length - cfg.maxPerTick) };
}
