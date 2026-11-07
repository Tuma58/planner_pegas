// «Моё поле» — поле управления руководителя отдела (проект «Слияние»,
// Э1, утверждено руководителем 07.11.2026). Один экран с параметром
// «отдел»: всё о своём отделе — коэффициент и его ход, потери машино-дней
// этапа, задачи, стыки с соседями (процессы «Рабочей среды СТ»), живые
// очереди рабочих экранов, люди, деньги ЦФО, инициативы. Своих формул
// здесь нет: секции раскладывают готовые каноны (parkReportData,
// reportSnapshot, «Цели и задачи», «Структура», «ЦФО») и прямые выборки
// очередей — те же данные, что видят рабочие экраны. Каждая секция ведёт
// в экран, где идёт работа.

export const FIELD_META = {
  log: { name: 'Отдел логистики', coef: 'КИП', lossKey: 'idle', lossLabel: 'простой укомплектованных без задания' },
  drv: { name: 'Отдел эксплуатации', coef: 'КВЛ', lossKey: 'noDriverShift', lossLabel: 'без водителя и пересменки' },
  toir: { name: 'Ремонтная служба (ТОиР)', coef: 'КТГ', lossKey: 'repair', lossLabel: 'в ремонте' },
  staff: { name: 'Штаб направления', coef: 'КЭИП', lossKey: 'total', lossLabel: 'все потери каскада' }
};
const COEF_KEY = { КТГ: 'ktg', КВЛ: 'kvl', КИП: 'kip', КЭИП: 'koef' };

// Стыки среды СТ (панель «Процессы и контроль»): что отдел передаёт
// соседу и что получает. Мерим бдительность — сколько сейчас «висит» на
// стыке и как долго, а не чужую цифру.
export const JOINTS = [
  { key: 'toir_drv', from: 'toir', to: 'drv', risk: 'починили — не укомплектовали',
    label: 'ТС из ремонта без водителя', screen: 'resource' },
  { key: 'drv_log', from: 'drv', to: 'log', risk: 'укомплектовали — не загрузили',
    label: 'укомплектованные ТС без задания', screen: 'logist' },
  // Третий стык ожил с карточкой ТС (нормы ТО на каждую машину, 07.11).
  { key: 'log_toir', from: 'log', to: 'toir', risk: 'гоняем — довели до поломки',
    label: 'ТО скоро или просрочено, заезд на ТО не запланирован', screen: 'toboard' }
];

const nowIso = () => new Date().toISOString();
const hoursSince = iso => iso ? Math.max(0, (Date.now() - Date.parse(iso)) / 3.6e6) : null;

// Машины «без задания»: в работе, сейчас нет рейса и нет плана вперёд,
// нет действующей диспозиции. Часы простоя — от выгрузки последнего рейса.
export function idleVehicles(db, at = nowIso()) {
  return db.prepare(`SELECT v.id, v.plate,
      (SELECT MAX(COALESCE(t.unloaded_at, t.ends_at)) FROM trips t
        WHERE t.vehicle_id=v.id AND t.status<>'rejected' AND t.ends_at<=?) last_end
    FROM vehicles v WHERE v.status='work'
      AND NOT EXISTS (SELECT 1 FROM trips t WHERE t.vehicle_id=v.id AND t.status IN ('plan','run')
        AND t.ends_at>?)
      AND NOT EXISTS (SELECT 1 FROM vehicle_dispositions d WHERE d.vehicle_id=v.id
        AND d.kind<>'reserve' AND d.starts_at<=? AND d.ends_at>?)
    ORDER BY last_end`).all(at, at, at, at)
    .map(row => ({ plate: row.plate, idleH: hoursSince(row.last_end) }));
}

// Живые очереди отдела и стыки — прямые выборки по текущему моменту.
export function fieldLive(db, dept, at = nowIso()) {
  const activeDispo = kind => db.prepare(`SELECT d.vehicle_id, v.plate, d.starts_at FROM vehicle_dispositions d
    JOIN vehicles v ON v.id=d.vehicle_id WHERE d.kind=? AND d.starts_at<=? AND d.ends_at>?
    ORDER BY d.starts_at`).all(kind, at, at);
  const idle = idleVehicles(db, at);
  const noDriver = activeDispo('no_driver');
  const fromRepair = noDriver.filter(row => db.prepare(`SELECT 1 FROM repair_orders WHERE vehicle_id=?
    AND status='released' AND released_at>=datetime(?, '-7 days')`).get(row.vehicle_id, at));
  const joints = JOINTS.map(joint => {
    const base = { ...joint, side: joint.from === dept ? 'out' : joint.to === dept ? 'in' : null };
    if (joint.pending) return { ...base, count: null };
    // Случаи журнала сквозного контроля (блок 4): у каждого — сигнал
    // контролёра и принятие владельцем; пока детектор не открыл случай
    // (первый тик), показываем сырой список условия.
    // Первыми — поданные и не принятые (их ждёт владелец стыка), затем
    // ещё не поданные (их ждёт контролёр): в показ попадают первые 12, и
    // поданный сигнал не должен теряться за сотней неподанных (07.11).
    const cases = db.prepare(`SELECT * FROM joint_signals WHERE joint_key=? AND closed_at IS NULL
      ORDER BY (signaled_at IS NOT NULL AND accepted_at IS NULL) DESC, signaled_at IS NOT NULL, opened_at`).all(joint.key);
    const list = cases.length ? cases.map(row => ({ id: row.id, plate: row.plate, hours: hoursSince(row.opened_at),
      signaledAt: row.signaled_at, signaledBy: row.signaled_by_name, acceptedAt: row.accepted_at, acceptedBy: row.accepted_by_name }))
      : joint.key === 'toir_drv'
        ? fromRepair.map(row => ({ plate: row.plate, hours: hoursSince(row.starts_at) }))
        : joint.key === 'drv_log' ? idle.map(row => ({ plate: row.plate, hours: row.idleH })) : [];
    const hours = list.map(row => row.hours).filter(Number.isFinite);
    return { ...base, count: list.length, maxH: hours.length ? Math.round(Math.max(...hours)) : null,
      waiting: list.filter(row => row.id && !row.signaledAt).length,
      signaled: list.filter(row => row.signaledAt && !row.acceptedAt).length,
      items: list.slice(0, 12) };
  }).filter(joint => dept === 'staff' || joint.side);
  const queues = [];
  if (dept === 'log' || dept === 'staff') {
    const orders = db.prepare(`SELECT COUNT(*) n, MIN(window_from) first FROM orders
      WHERE deleted_at IS NULL AND trip_id IS NULL AND status NOT IN ('rejected','cancelled')
        AND window_to>=?`).get(at);
    queues.push({ key: 'orders', dept: 'log', label: 'Заявки без ТС', count: orders.n,
      note: orders.first ? `ближайшее окно ${orders.first.slice(0, 16).replace('T', ' ')}` : '', screen: 'logist' });
    queues.push({ key: 'idle', dept: 'log', label: 'Свободные ТС без задания', count: idle.length,
      note: idle[0]?.idleH != null ? `дольше всех ${Math.round(idle[0].idleH)} ч` : '', screen: 'logist' });
    const late = db.prepare(`SELECT COUNT(*) n FROM trips WHERE status='run' AND ends_at<?`).get(at).n;
    queues.push({ key: 'late', dept: 'log', label: 'Рейсы в пути позже срока', count: late, screen: 'dispatcher' });
  }
  if (dept === 'drv' || dept === 'staff') {
    queues.push({ key: 'no_driver', dept: 'drv', label: 'ТС без водителя', count: noDriver.length,
      note: noDriver.length ? noDriver.slice(0, 5).map(row => row.plate).join(', ') : '', screen: 'resource' });
    queues.push({ key: 'shift', dept: 'drv', label: 'На пересменке', count: activeDispo('shift').length, screen: 'resource' });
    // КПП базы (07.11): грузовые на стоянке по журналу охраны.
    const onBase = db.prepare(`SELECT plate FROM gate_log WHERE status='onsite' AND type='truck' ORDER BY entry_at`).all();
    queues.push({ key: 'on_base', dept: 'drv', label: 'Грузовых на стоянке базы (КПП)', count: onBase.length,
      note: onBase.slice(0, 6).map(row => row.plate).join(', '), screen: 'gate' });
  }
  if (dept === 'toir' || dept === 'staff') {
    const repair = db.prepare(`SELECT COUNT(*) n, SUM(CASE WHEN planned_out IS NOT NULL AND planned_out<? THEN 1 ELSE 0 END) late
      FROM repair_orders WHERE status IN ('queued','in_progress','ready')`).get(at);
    queues.push({ key: 'repair', dept: 'toir', label: 'В ремонте', count: repair.n, screen: 'remzona' });
    queues.push({ key: 'repair_late', dept: 'toir', label: 'Просрочен выпуск из ремонта', count: repair.late || 0, screen: 'remzona' });
  }
  return { joints, queues };
}

// Сборка поля: ctx — готовые каноны, посчитанные сервером за период.
// ctx: { dept, month, from, to, park (parkReportData целиком), snap,
//   goals (срез «Целей»), structure (срез «Структуры»), cfo (срез ЦФО|null),
//   live (fieldLive), shifts ([{name, kind}]), targets }
export function fieldData(ctx) {
  const meta = FIELD_META[ctx.dept];
  const coefKey = COEF_KEY[meta.coef];
  const md = ctx.snap?.utilization?.machineDays || {};
  const losses = {
    idle: md.idle || 0, repair: md.repair || 0, noDriverShift: (md.noDriver || 0) + (md.shift || 0),
    total: (md.idle || 0) + (md.repair || 0) + (md.noDriver || 0) + (md.shift || 0) + (md.out || 0)
  };
  const dept = ctx.structure?.depts?.find(item => item.key === ctx.dept);
  const tasks = (ctx.goals?.items || []).filter(item => item.dept === ctx.dept);
  // Светофор задач — по задачам ЭТОГО отдела, не всего направления.
  const summary = { ok: 0, near: 0, miss: 0, info: 0, none: 0 };
  for (const task of tasks.filter(item => item.kind === 'task')) summary[task.metric?.tone || 'none'] += 1;
  return {
    dept: ctx.dept, ...meta, month: ctx.month, from: ctx.from, to: ctx.to,
    coef: { value: ctx.park?.total?.[coefKey] ?? null, target: ctx.targets?.[meta.coef] ?? null,
      weeks: (ctx.park?.weeks || []).slice(-6).map(week => ({ from: week.from, value: week[coefKey] })) },
    machineDays: { lost: losses[meta.lossKey], label: meta.lossLabel, calendar: ctx.snap?.utilization?.calendarDays || 0,
      breakdown: md },
    tasks, summary,
    people: dept ? { headcount: dept.headcount, fact: dept.fact, vacancies: dept.vacancies,
      noRole: ctx.structure.totals.noRole,
      openPositions: ctx.structure.positions.filter(item => item.dept === ctx.dept && item.vacancies)
        .map(item => ({ title: item.title, vacancies: item.vacancies })),
      onShift: ctx.shifts || [] } : null,
    money: ctx.cfo?.centers?.find(center => center.key === ctx.dept) || null,
    initiatives: ctx.goals?.initiatives?.[ctx.dept] || null,
    ...ctx.live
  };
}

// ── Поле направления (Э2, 07.11) — Штаб и руководитель направления ──
// Свод: каскад КТГ→КВЛ→КИП→КЭИП против целей, выручка против плана и
// стратегии, водопад машино-дней (календарь → ремонт → без водителя и
// пересменки → простой без задания → под заданием), все стыки и карточки
// трёх отделов — те же поля, что видят их руководители (провал кликом).
// ctx — как у fieldData, но с полными (не срезанными) goals/structure/cfo;
// live — { log, drv, toir, staff } из fieldLive.
export function directionData(ctx, live) {
  const total = ctx.park?.total || {};
  const md = ctx.snap?.utilization?.machineDays || {};
  const calendar = ctx.snap?.utilization?.calendarDays || 0;
  const depts = ['log', 'drv', 'toir'].map(dept => fieldData({ ...ctx, dept, live: live[dept] }));
  const staff = fieldData({ ...ctx, dept: 'staff', live: live.staff });
  const revenueMetric = (ctx.goals?.head || []).find(metric => metric?.key === 'revenue_month') || null;
  return {
    direction: true, dept: 'direction', name: 'Направление СТ', month: ctx.month, from: ctx.from, to: ctx.to,
    cascade: [['КТГ', 'ktg', 'toir'], ['КВЛ', 'kvl', 'drv'], ['КИП', 'kip', 'log'], ['КЭИП', 'koef', 'staff']]
      .map(([coef, key, dept]) => ({ coef, dept, value: total[key] ?? null, target: ctx.targets?.[coef] ?? null })),
    revenue: revenueMetric,
    waterfall: calendar ? [
      { key: 'calendar', label: 'Календарь парка', value: calendar },
      { key: 'repair', label: 'Ремонт · ТОиР', value: -(md.repair || 0), dept: 'toir' },
      { key: 'out', label: 'Выведены', value: -(md.out || 0), dept: 'toir' },
      { key: 'noDriver', label: 'Без водителя и пересменки · Эксплуатация', value: -((md.noDriver || 0) + (md.shift || 0)), dept: 'drv' },
      { key: 'idle', label: 'Простой без задания · Логистика', value: -(md.idle || 0), dept: 'log' },
      { key: 'work', label: 'Под заданием', value: md.work || 0, total: true }
    ] : [],
    joints: JOINTS.map(joint => {
      const found = (live.staff?.joints || []).find(item => item.key === joint.key);
      return found || { ...joint, count: null };
    }),
    depts: depts.map(dept => ({ dept: dept.dept, name: dept.name, coef: dept.coef, machineDays: dept.machineDays,
      summary: dept.summary, people: dept.people, money: dept.money,
      queues: dept.queues.filter(queue => queue.dept === dept.dept),
      joints: dept.joints.map(joint => ({ key: joint.key, side: joint.side, count: joint.count, risk: joint.risk })) })),
    staff: { tasks: staff.tasks, summary: staff.summary, people: staff.people, initiatives: staff.initiatives },
    initiatives: ctx.goals?.initiatives || null
  };
}
