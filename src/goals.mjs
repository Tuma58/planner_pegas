// «Цели и задачи» направления СТ (проект «Слияние», блок 2, 07.11.2026).
// Тексты (миссия, стратегические цели, цели и задачи отделов, принципы)
// живут в планере — разовая загрузка из «Рабочей среды СТ» (метка
// org_goals_v1), дальше правит руководитель. У цели/задачи — ключ живого
// показателя из КАТАЛОГА ниже: ключ → значение из существующих канонов
// (parkReportData, reportSnapshot, mileageData, structureData, Ремзона,
// журнал затрат, HELP DESK). Своих формул здесь нет: каталог только
// раскладывает готовые цифры. Этот же каталог возьмут блоки «KPI и
// каскад» и «ФОТ» — KPI паспорта должности будет ссылаться на ключ.
// Цели для сравнения — только из реестра целей направления
// (goals-core.js); показатель без цели — справочный (серый), не «красный».

import { randomUUID } from 'node:crypto';

const KINDS = ['mission', 'strategy', 'dept', 'task', 'principle'];

// Первая загрузка — тексты «Рабочей среды СТ» (renderGoals, 04.11).
const SEED = [
  { kind: 'mission', title: 'Миссия', body: 'Надёжная доставка рефрижераторных грузов FTL по маршруту Пенза–Москва при максимальной отдаче парка и управляемой себестоимости.' },
  { kind: 'strategy', title: 'Загрузка парка', metric: 'keip', body: 'Довести использование парка до 95% через управляемый каскад КТГ→КВЛ→КИП. Каждый простаивающий ТС — потерянный машино-день.' },
  { kind: 'strategy', title: 'Доходность рейса', metric: 'km_day', body: 'Держать среднесуточный пробег и маржу машино-дня, минимизировать пустой пробег и порожние сутки. Логистика — центр дохода.' },
  { kind: 'strategy', title: 'Управляемая себестоимость', metric: 'fot', body: 'ФОТ управления — в рамках норматива % выручки, прозрачные ЦФО, сдельная оплата водителей от результата (Положение с 01.10.2026).' },
  { kind: 'dept', dept: 'toir', title: 'Держать техническую готовность парка.', metric: 'ktg' },
  { kind: 'task', dept: 'toir', title: 'Плановый ТОиР без срыва пробега и окон', metric: 'pending:Процессы и контроль' },
  { kind: 'task', dept: 'toir', title: 'Быстрый возврат ТС из ремонта на линию', metric: 'repair_days' },
  { kind: 'task', dept: 'toir', title: 'Снабжение запчастями без простоя постов', metric: 'pending:Процессы и контроль' },
  { kind: 'task', dept: 'toir', title: 'Укомплектованность постов и смен', metric: 'staffing_toir' },
  { kind: 'dept', dept: 'drv', title: 'Максимум укомплектованных ТС на линии.', metric: 'kvl' },
  { kind: 'task', dept: 'drv', title: 'Выпуск исправных ТС с экипажем', metric: 'kvl' },
  { kind: 'task', dept: 'drv', title: 'Закрепление водителей за ТС и экипажами', metric: 'no_driver_md' },
  { kind: 'task', dept: 'drv', title: 'Дисциплина, БДД, демотивации', metric: 'fines' },
  { kind: 'task', dept: 'drv', title: 'Табель и графики работы', metric: 'staffing_drivers' },
  { kind: 'dept', dept: 'log', title: 'Загрузить каждый выпущенный ТС с максимальной маржой.', metric: 'kip' },
  { kind: 'task', dept: 'log', title: 'Планирование рейсов и загрузки', metric: 'next_assigned' },
  { kind: 'task', dept: 'log', title: 'Минимизация пустого пробега', metric: 'empty_km' },
  { kind: 'task', dept: 'log', title: 'Маржа машино-дня', metric: 'margin_md' },
  { kind: 'task', dept: 'log', title: 'КЭИП и свод эффективности парка', metric: 'keip' },
  { kind: 'dept', dept: 'staff', title: 'Свести результат направления и удержать норматив.', metric: 'keip' },
  { kind: 'task', dept: 'staff', title: 'Сведение КЭИП и P&L направления', metric: 'revenue_month' },
  { kind: 'task', dept: 'staff', title: 'Норматив ФОТ под выручку', metric: 'fot' },
  { kind: 'task', dept: 'staff', title: 'БДД, АХО, охрана, пропускной режим', metric: 'helpdesk_open' },
  { kind: 'task', dept: 'staff', title: 'Контроль сквозных стыков между отделами', metric: 'pending:Процессы и контроль' },
  { kind: 'principle', title: 'Машино-день — единая единица', body: 'Все три отдела меряются рабочими машино-днями; премия отдела привязана к машино-дням и ЦФО.' },
  { kind: 'principle', title: 'Сквозной контроль стыков', body: 'Каждый отдел контролирует передачу соседу — мерим бдительность (скорость и полноту сигнала), а не чужую цифру.' },
  { kind: 'principle', title: '70–80% свой KPI / 20–30% контроль', body: 'Основной вес — на собственном показателе отдела, меньшая доля — за контроль смежника.' },
  { kind: 'principle', title: 'Светофорный ритм', body: 'Ежедневное управление на едином поле: статусы ТС и задач по светофору.' },
  { kind: 'principle', title: 'Мотивация от результата', body: 'Положение по оплате водителей с 01.10.2026; премии аппарата — от машино-дней и маржи.' }
];

export function migrateGoals(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS org_goals (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK(kind IN ('mission','strategy','dept','task','principle')),
    dept_key TEXT NOT NULL DEFAULT '', title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
    metric_key TEXT NOT NULL DEFAULT '', sort INTEGER NOT NULL DEFAULT 0,
    archived_at TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  if (db.prepare(`SELECT 1 FROM app_meta WHERE key='org_goals_v1'`).get()) return;
  if (!db.prepare(`SELECT COUNT(*) c FROM org_goals`).get().c) {
    const insert = db.prepare(`INSERT INTO org_goals(id,kind,dept_key,title,body,metric_key,sort)
      VALUES(?,?,?,?,?,?,?)`);
    SEED.forEach((item, index) => insert.run(`g-${index + 1}`, item.kind, item.dept || '',
      item.title, item.body || '', item.metric || '', index + 1));
  }
  db.prepare(`INSERT OR IGNORE INTO app_meta(key,value) VALUES('org_goals_v1','st-20261104')`).run();
}

// ── Каталог живых показателей ──
// value(ctx) → число или null (нет данных за период); target(ctx) → цель
// из реестра или null (справочный показатель); dir — что лучше.
// Тон: в норме — не хуже цели; близко — в пределах 5% цели; иначе мимо.
export const METRICS = {
  revenue_month: { label: 'Выручка месяца без НДС', unit: 'млн ₽', dir: 'max', screen: 'boss',
    value: c => c.snap ? +(c.snap.netRevenue / 1e6).toFixed(1) : null,
    target: c => c.revenuePlanMln ?? c.goals.revenueMln,
    note: c => c.revenuePlanMln ? `план месяца ${c.revenuePlanMln} · стратегия ${c.goals.revenueMln}` : `стратегия ${c.goals.revenueMln}` },
  keip: { label: 'КЭИП — использование парка', unit: '%', dir: 'max', screen: 'dashboard',
    value: c => c.park?.koef ?? null, target: c => c.goals.use },
  ktg: { label: 'КТГ — исправные от списка', unit: '%', dir: 'max', screen: 'remzona',
    value: c => c.park?.ktg ?? null, target: c => c.goals.ktg },
  kvl: { label: 'КВЛ — укомплектованные от исправных', unit: '%', dir: 'max', screen: 'resource',
    value: c => c.park?.kvl ?? null, target: c => c.goals.kvl },
  kip: { label: 'КИП — с заданием от укомплектованных', unit: '%', dir: 'max', screen: 'logist',
    value: c => c.park?.kip ?? null, target: c => c.goals.kip },
  km_day: { label: 'Среднесуточный пробег на машину', unit: 'км', dir: 'max', screen: 'boss',
    value: c => c.mileage?.perDayPerVehicle || null, target: c => c.goals.kmDay },
  fleet: { label: 'Списочный парк', unit: 'ТС', dir: 'max', screen: 'resource',
    value: c => c.park?.fleet ?? null, target: c => c.goals.fleet },
  fot: { label: 'ФОТ управления, % выручки', unit: '%', dir: 'min', screen: '',
    value: () => null, target: c => c.goals.fotPct, pending: 'ФОТ' },
  repair_days: { label: 'Срок ремонта (медиана заездов)', unit: 'сут', dir: 'min', screen: 'remzona',
    value: c => c.repairDays, target: () => null },
  staffing_toir: { label: 'Укомплектованность ТОиР', unit: '%', dir: 'max', screen: 'structure',
    value: c => c.staffing?.toir ?? null, target: () => 100 },
  staffing_drivers: { label: 'Водители от штата', unit: '%', dir: 'max', screen: 'resource',
    value: c => c.staffing?.drivers ?? null, target: () => 100 },
  no_driver_md: { label: 'Машино-дни «без водителя»', unit: 'МД', dir: 'min', screen: 'resource',
    value: c => c.snap?.utilization?.machineDays?.noDriver ?? null, target: () => null },
  fines: { label: 'Штрафы ГИБДД (оплаченные)', unit: 'шт', dir: 'min', screen: 'expenses',
    value: c => c.fines, target: () => null },
  next_assigned: { label: 'Задание до выгрузки', unit: '%', dir: 'max', screen: 'logist',
    value: c => c.nextAssigned, target: () => null },
  empty_km: { label: 'Доля порожних км', unit: '%', dir: 'min', screen: 'boss',
    value: c => c.mileage?.totalKm ? +(c.mileage.emptyKm / c.mileage.totalKm * 100).toFixed(1) : null,
    target: () => null },
  margin_md: { label: 'Маржа машино-дня в рейсе', unit: '₽', dir: 'max', screen: 'boss',
    value: c => c.snap?.utilization?.marginPerTripDay || null, target: () => null },
  helpdesk_open: { label: 'Открытые заявки HELP DESK', unit: 'шт', dir: 'min', screen: '',
    value: c => c.helpdeskOpen, target: () => null }
};

export function metricOptions() {
  return Object.entries(METRICS).map(([key, m]) => ({ key, label: m.label, unit: m.unit }));
}

function tone(value, target, dir) {
  if (value == null) return 'none';
  if (target == null) return 'info';
  const ok = dir === 'min' ? value <= target : value >= target;
  if (ok) return 'ok';
  const gap = Math.abs(value - target) / Math.max(Math.abs(target), 1e-9);
  return gap <= 0.05 ? 'near' : 'miss';
}

export function evalMetric(key, ctx) {
  if (!key) return null;
  if (key.startsWith('pending:')) return { key, pending: key.slice(8), tone: 'none' };
  const m = METRICS[key];
  if (!m) return { key, label: key, tone: 'none', unknown: true };
  let value = null;
  let target = null;
  try { value = m.value(ctx); } catch { value = null; }
  try { target = m.target(ctx); } catch { target = null; }
  return { key, label: m.label, unit: m.unit, dir: m.dir, screen: m.screen, value, target,
    note: m.note ? m.note(ctx) : '', pending: m.pending && value == null ? m.pending : '',
    tone: tone(value, target, m.dir) };
}

export function goalsData(db, ctx) {
  const rows = db.prepare(`SELECT * FROM org_goals WHERE archived_at IS NULL ORDER BY sort`).all();
  const items = rows.map(row => ({ id: row.id, kind: row.kind, dept: row.dept_key, title: row.title,
    body: row.body, metricKey: row.metric_key, sort: row.sort, metric: evalMetric(row.metric_key, ctx) }));
  const tasks = items.filter(item => item.kind === 'task');
  const summary = { ok: 0, near: 0, miss: 0, info: 0, none: 0 };
  for (const task of tasks) summary[task.metric?.tone || 'none'] += 1;
  return {
    items,
    head: ['revenue_month', 'keip', 'km_day', 'fleet'].map(key => evalMetric(key, ctx)),
    summary,
    metrics: metricOptions()
  };
}

// Срез по области (поле управления, 07.11): руководитель отдела видит
// цель и задачи СВОЕГО отдела; миссия, стратегия и итоги направления —
// у области «всё направление».
export function scopeGoals(data, scope, ctx) {
  if (!scope || scope.all) return data;
  const keep = new Set(scope.depts);
  const items = data.items.filter(item => ['dept', 'task'].includes(item.kind) && keep.has(item.dept));
  const summary = { ok: 0, near: 0, miss: 0, info: 0, none: 0 };
  for (const task of items.filter(item => item.kind === 'task')) summary[task.metric?.tone || 'none'] += 1;
  const head = items.filter(item => item.kind === 'dept').map(item => item.metric).filter(Boolean);
  return { ...data, items, head, summary, scoped: true };
}

// Правка руководителем: текст, показатель, порядок; новые задачи/цели.
export function saveGoal(db, body = {}) {
  const title = String(body.title || '').trim();
  if (!title) return { ok: false, status: 422, error: 'Пустой текст' };
  const metric = String(body.metricKey || '');
  if (metric && !metric.startsWith('pending:') && !METRICS[metric]) {
    return { ok: false, status: 422, error: 'Неизвестный показатель' };
  }
  if (body.id) {
    const current = db.prepare(`SELECT * FROM org_goals WHERE id=? AND archived_at IS NULL`).get(body.id);
    if (!current) return { ok: false, status: 404, error: 'Не найдено' };
    db.prepare(`UPDATE org_goals SET title=?, body=?, metric_key=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(title, String(body.body ?? current.body), metric, body.id);
    return { ok: true, id: body.id, before: { title: current.title, metricKey: current.metric_key } };
  }
  if (!KINDS.includes(body.kind) || body.kind === 'mission') return { ok: false, status: 422, error: 'Вид записи' };
  if (['dept', 'task'].includes(body.kind) && !['staff', 'log', 'drv', 'toir'].includes(body.dept)) {
    return { ok: false, status: 422, error: 'Укажите отдел' };
  }
  const sort = db.prepare(`SELECT COALESCE(MAX(sort),0)+1 s FROM org_goals`).get().s;
  const id = `g-${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO org_goals(id,kind,dept_key,title,body,metric_key,sort) VALUES(?,?,?,?,?,?,?)`)
    .run(id, body.kind, ['dept', 'task'].includes(body.kind) ? body.dept : '', title,
      String(body.body || ''), metric, sort);
  return { ok: true, id };
}

export function archiveGoal(db, id) {
  const current = db.prepare(`SELECT kind, title FROM org_goals WHERE id=? AND archived_at IS NULL`).get(id);
  if (!current) return { ok: false, status: 404, error: 'Не найдено' };
  if (current.kind === 'mission') return { ok: false, status: 422, error: 'Миссию не удаляют — правьте текст' };
  db.prepare(`UPDATE org_goals SET archived_at=CURRENT_TIMESTAMP WHERE id=?`).run(id);
  return { ok: true, title: current.title };
}

// Висяки (Фридман, 14.11): цель отдела без единой задачи и задачи
// отдела без цели — дерево целей с дырами не управляет; плюс задачи
// без живого показателя (их светофор всегда пуст).
export function goalsOrphans(db) {
  const rows = db.prepare(`SELECT kind, dept_key, title, metric_key FROM org_goals WHERE archived_at IS NULL`).all();
  const hasTask = dept => rows.some(row => row.kind === 'task' && row.dept_key === dept);
  const hasGoal = dept => rows.some(row => row.kind === 'dept' && row.dept_key === dept);
  return {
    goalsWithoutTasks: rows.filter(row => row.kind === 'dept' && !hasTask(row.dept_key))
      .map(row => ({ dept: row.dept_key, title: row.title })),
    tasksWithoutGoal: rows.filter(row => row.kind === 'task' && !hasGoal(row.dept_key))
      .map(row => ({ dept: row.dept_key, title: row.title })),
    noMetric: rows.filter(row => row.kind === 'task' && (!row.metric_key || row.metric_key.startsWith('pending:')))
      .map(row => ({ dept: row.dept_key, title: row.title }))
  };
}

// Строка для «📐 Нормативов недели»: светофор задач и сдвиг к прошлой неделе.
export function goalsDigestLine(summary, last) {
  const shift = last && Number.isFinite(last.ok) ? ` (было ${last.ok}/${last.near}/${last.miss})` : '';
  return ` · 🎯 цели направления: задачи в норме ${summary.ok} · близко ${summary.near} · мимо ${summary.miss}${shift}` +
    `, справочно ${summary.info}, без источника ${summary.none}`;
}
