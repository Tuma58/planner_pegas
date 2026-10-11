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
  for (const row of db.prepare(`SELECT u.full_name name, u.role, COALESCE(u.roles,'') roles
      FROM staff_shifts s JOIN users u ON u.id=s.user_id
      WHERE s.day=? AND s.kind IN ('day','night') AND u.active=1`).all(day)) {
    people.set(row.name, { name: row.name, onShift: true,
      dispatcherRole: row.role === 'dispatcher' || row.role === 'admin'
        || row.roles.includes('dispatcher') });
  }
  for (const name of today.keys()) {
    if (!people.has(name)) {
      const user = db.prepare(`SELECT role, COALESCE(roles,'') roles FROM users
        WHERE full_name=? AND active=1`).get(name);
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
