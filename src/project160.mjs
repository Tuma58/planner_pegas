// Проект «160 млн»: внутренний экран развития продукта.
//
// Гипотеза, вокруг которой всё построено: главные потери — время на
// операции и на передачу данных между участниками перевозки. Поэтому здесь
// меряется не «сколько сделали фич», а сквозное время движения заявки по
// ролям: продажи → логист → диспетчер → линия. Каждое улучшение продукта
// фиксирует снимок метрик «до» и сравнивается с текущим.
const HOUR = 3_600_000;

const ts = value => {
  if (!value) return NaN;
  const text = String(value);
  return Date.parse(text.includes('T') ? text : `${text.replace(' ', 'T')}Z`);
};

const median = list => {
  if (!list.length) return 0;
  const sorted = [...list].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

// Этапы передачи: от чего до чего считаем время и чей это шаг. Нормативы —
// из регламентов, по ним видно, где процесс встал.
export const HANDOFFS = [
  { key: 'sales_confirm', label: 'Заявка внесена → подтверждена продажами',
    owner: 'Продажи', normHours: 4 },
  { key: 'logist_assign', label: 'Подтверждена → назначено ТС',
    owner: 'Логист', normHours: 4 },
  { key: 'logist_confirm', label: 'Назначено ТС → подтверждено логистом',
    owner: 'Логист', normHours: 1 },
  { key: 'dispatch_1c', label: 'Подтверждено → внесено в 1С',
    owner: 'Диспетчер', normHours: 2 },
  { key: 'driver_task', label: 'Внесено в 1С → задание водителю',
    owner: 'Диспетчер', normHours: 1 },
  { key: 'on_line', label: 'Задание водителю → вывод на линию',
    owner: 'Диспетчер', normHours: 2 },
  // Управляемая часть цепочки: всё, что зависит только от нас. Сквозное
  // время до линии включает ожидание планового выхода (машина ждёт окна
  // погрузки) — это не потеря, и смешивать их нельзя.
  { key: 'managed_chain', label: 'УПРАВЛЯЕМОЕ: заявка → задание водителю',
    owner: 'Конвейер', normHours: 8 },
  { key: 'total_chain', label: 'СПРАВОЧНО: заявка → машина на линии (с ожиданием окна)',
    owner: 'Конвейер', normHours: 14 }
];

// Время передачи по каждому стыку за период. Берём рейсы, вышедшие на
// линию в периоде: у них цепочка пройдена целиком и её можно померить.
export function handoffMetrics(db, fromIso, toIso) {
  const trips = db.prepare(`SELECT t.*, o.created_at order_created, o.confirmed_at order_confirmed
    FROM trips t LEFT JOIN orders o ON o.id=t.order_id
    WHERE t.on_line_at IS NOT NULL AND t.on_line_at>=? AND t.on_line_at<?
      AND t.status<>'rejected'`).all(fromIso, toIso);
  const buckets = new Map(HANDOFFS.map(item => [item.key, []]));
  for (const trip of trips) {
    const created = ts(trip.order_created);
    const confirmed = ts(trip.order_confirmed);
    const assigned = ts(trip.created_at);
    const logist = ts(trip.logist_confirmed_at);
    const entered = ts(trip.entered_1c_at) || ts(trip.deferred_1c_at);
    const notified = ts(trip.driver_notified_at);
    const online = ts(trip.on_line_at);
    const push = (key, from, to) => {
      if (!Number.isFinite(from) || !Number.isFinite(to)) return;
      const ms = to - from;
      // Отрицательные и абсурдные разрывы — следы ручных правок задним
      // числом, в медиану их пускать нельзя.
      if (ms < 0 || ms > 30 * 24 * HOUR) return;
      buckets.get(key).push(ms);
    };
    push('sales_confirm', created, confirmed);
    push('logist_assign', confirmed, assigned);
    push('logist_confirm', assigned, logist);
    push('dispatch_1c', logist, entered);
    push('driver_task', entered, notified);
    push('on_line', notified, online);
    push('managed_chain', created, notified);
    push('total_chain', created, online);
  }
  return HANDOFFS.map(item => {
    const list = buckets.get(item.key);
    const med = median(list);
    const overNorm = list.filter(ms => ms > item.normHours * HOUR).length;
    return { ...item, count: list.length, medianHours: Math.round(med / HOUR * 10) / 10,
      overNorm, overPct: list.length ? Math.round(overNorm / list.length * 100) : 0 };
  });
}

// Операционные метрики: сколько действий стоит работа и как быстро
// отвечаем водителю. Это то, что мы сокращаем изменениями продукта.
export function operationMetrics(db, fromIso, toIso) {
  const count = (action, entity) => db.prepare(`SELECT COUNT(*) c FROM audit_log
    WHERE created_at>=? AND created_at<? AND action=? AND entity=?`).get(fromIso, toIso, action, entity).c;
  const dispositionOps = count('create', 'disposition') + count('update', 'disposition')
    + count('delete', 'disposition');
  const stopFacts = db.prepare(`SELECT COUNT(*) c FROM audit_log
    WHERE created_at>=? AND created_at<? AND entity='trip_stop'`).get(fromIso, toIso).c;
  const questions = db.prepare(`SELECT opened_at, closed_at FROM driver_questions
    WHERE opened_at>=? AND opened_at<?`).all(fromIso, toIso);
  const answered = questions.filter(item => item.closed_at)
    .map(item => ts(item.closed_at) - ts(item.opened_at)).filter(ms => ms >= 0);
  const trips = db.prepare(`SELECT COUNT(*) c FROM trips
    WHERE on_line_at>=? AND on_line_at<? AND status<>'rejected'`).get(fromIso, toIso).c;
  return {
    dispositionOps,
    stopFacts,
    stopFactsPerTrip: trips ? Math.round(stopFacts / trips * 10) / 10 : 0,
    trips,
    questions: questions.length,
    questionsAnswered: answered.length,
    questionMedianMin: answered.length ? Math.round(median(answered) / 60_000) : 0,
    questionInSlaPct: answered.length
      ? Math.round(answered.filter(ms => ms <= 10 * 60_000).length / answered.length * 100) : 0
  };
}

// Деньги месяца: план против факта по дате выгрузки — ради чего всё.
export function moneyMetrics(db, fromIso, toIso) {
  const rows = db.prepare(`SELECT status, revenue_vat, unloaded_at, ends_at FROM trips
    WHERE status<>'rejected'`).all();
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  let fact = 0;
  let planned = 0;
  let trips = 0;
  for (const row of rows) {
    const at = ts(row.unloaded_at) || ts(row.ends_at);
    if (!(at >= from && at < to)) continue;
    trips += 1;
    if (['unloaded', 'done', 'paid'].includes(row.status)) fact += Number(row.revenue_vat || 0);
    else planned += Number(row.revenue_vat || 0);
  }
  const plan = db.prepare(`SELECT target_net FROM revenue_plans
    WHERE period_start=? LIMIT 1`).get(fromIso.slice(0, 10))?.target_net || 0;
  // План ставится БЕЗ НДС (так его считает руководитель), а выручка рейсов
  // хранится с НДС — приводим к одной базе, иначе цель и факт несопоставимы.
  const vatRate = Number(JSON.parse(db.prepare(`SELECT value_json v FROM settings
    WHERE key='calculation'`).get()?.v || '{}').vatRate) || 0.22;
  return { fact: Math.round(fact), planned: Math.round(planned), trips,
    targetNet: plan, vatRate,
    factNet: Math.round(fact / (1 + vatRate)),
    plannedNet: Math.round(planned / (1 + vatRate)) };
}

// Метрики, которые считаются из данных: по ним прогресс инициативы виден
// сам, без ручных галочек. `less` — цель «не больше», `more` — «не меньше».
export const METRICS = {
  claims_open: { label: 'Претензий не выставлено', unit: 'шт', dir: 'less' },
  idle_days: { label: 'Простой без причины', unit: 'машино-дней', dir: 'less' },
  no_driver_days: { label: 'Машино-дни без водителя', unit: 'дней', dir: 'less' },
  repair_days: { label: 'Машино-дни в ремонте', unit: 'дней', dir: 'less' },
  expired_orders: { label: 'Заявки с истёкшим окном без ТС', unit: 'шт', dir: 'less' },
  reject_other: { label: 'Срывы с причиной «Прочее»', unit: 'шт', dir: 'less' },
  empty_pct: { label: 'Доля порожнего пробега', unit: '%', dir: 'less' },
  assign_lag_h: { label: 'Подтверждена → назначено ТС', unit: 'ч', dir: 'less' },
  assign_late_pct: { label: 'Назначено после начала окна', unit: '%', dir: 'less' },
  rate_per_km: { label: 'Ставка', unit: '₽/км', dir: 'more' },
  next_month_orders: { label: 'Портфель следующего месяца', unit: '₽', dir: 'more' },
  question_sla_pct: { label: 'Ответы водителям в 10 минут', unit: '%', dir: 'more' },
  shipper_notified_pct: { label: 'Данные грузоотправителю до выхода', unit: '%', dir: 'more' },
  leg_gap_h: { label: 'Зазор стыковки между рейсами', unit: 'ч', dir: 'less' },
  planned_3d_pct: { label: 'Заявки, внесённые за 3+ дня', unit: '%', dir: 'more' }
};

// Текущее значение метрики за период. Одна функция на все инициативы —
// иначе цифры в проекте разойдутся с отчётами.
export function metricValue(db, key, fromIso, toIso) {
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  switch (key) {
    case 'claims_open':
      return one(`SELECT COUNT(*) v FROM demurrage_claims WHERE status='new'`).v;
    case 'expired_orders':
      return one(`SELECT COUNT(*) v FROM orders WHERE deleted_at IS NULL AND status<>'rejected'
        AND trip_id IS NULL AND window_to < CURRENT_TIMESTAMP AND window_to >= ?`, fromIso).v;
    case 'reject_other':
      return one(`SELECT COUNT(*) v FROM trips WHERE status='rejected'
        AND rejection_reason='Прочее' AND starts_at>=? AND starts_at<?`, fromIso, toIso).v;
    case 'question_sla_pct': {
      const stats = operationMetrics(db, fromIso, toIso);
      return stats.questionInSlaPct;
    }
    case 'assign_lag_h': {
      const row = handoffMetrics(db, fromIso, toIso).find(item => item.key === 'logist_assign');
      return row ? row.medianHours : 0;
    }
    case 'rate_per_km': {
      const row = one(`SELECT SUM(revenue_vat) r, SUM(distance_km) k FROM trips
        WHERE status IN ('unloaded','done','paid') AND unloaded_at>=? AND unloaded_at<?`, fromIso, toIso);
      return row.k ? Math.round(row.r / row.k) : 0;
    }
    case 'empty_pct': {
      const row = one(`SELECT SUM(distance_km) k, SUM(empty_km) e FROM trips
        WHERE status<>'rejected' AND on_line_at>=? AND on_line_at<?`, fromIso, toIso);
      const total = Number(row.k || 0) + Number(row.e || 0);
      return total ? Math.round(Number(row.e || 0) / total * 1000) / 10 : 0;
    }
    case 'next_month_orders': {
      const next = new Date(Date.parse(`${toIso}T00:00:00Z`));
      next.setUTCMonth(next.getUTCMonth() + 1);
      return Math.round(one(`SELECT COALESCE(SUM(rate_vat),0) v FROM orders
        WHERE deleted_at IS NULL AND status<>'rejected' AND window_from>=? AND window_from<?`,
      toIso, next.toISOString().slice(0, 10)).v);
    }
    case 'shipper_notified_pct': {
      // Доля рейсов, выведенных на линию с отметкой «данные направлены».
      // Отметка появилась 30.08 — сравнивать с августом нельзя, растим с нуля.
      const row = one(`SELECT COUNT(*) total,
          SUM(CASE WHEN shipper_notified_at IS NOT NULL THEN 1 ELSE 0 END) sent
        FROM trips WHERE status<>'rejected' AND on_line_at IS NOT NULL
          AND on_line_at>=? AND on_line_at<?`, fromIso, toIso);
      return row.total ? Math.round(row.sent / row.total * 100) : null;
    }
    case 'planned_3d_pct': {
      // Горизонт планирования: доля заявок, внесённых за 72+ часа до окна
      // погрузки. Пока работа планируется «на сегодня», выходные продаж
      // невозможны — двое людей работают 14 дней подряд без подмены.
      const row = one(`SELECT COUNT(*) total,
          SUM(CASE WHEN julianday(window_from) - julianday(created_at) >= 3 THEN 1 ELSE 0 END) early
        FROM orders WHERE deleted_at IS NULL AND status<>'rejected'
          AND created_at>=? AND created_at<?`, fromIso, toIso);
      return row.total ? Math.round(row.early / row.total * 100) : null;
    }
    case 'leg_gap_h': {
      // Средний простой сцепки между рейсами: от освобождения (факт выгрузки,
      // иначе план) до старта следующего рейса. Август: 0,85 дня на рейс —
      // машина в рейсе лишь 66% рабочего времени; каждый час зазора по парку
      // стоит ~770 ₽ маржи на машину. Цель — 8 часов.
      const rows = db.prepare(`SELECT vehicle_id, starts_at,
          COALESCE(unloaded_at, ends_at) done_at
        FROM trips WHERE status<>'rejected' AND starts_at>=? AND starts_at<?
        ORDER BY vehicle_id, starts_at`).all(fromIso, toIso);
      const gaps = [];
      for (let i = 1; i < rows.length; i += 1) {
        if (rows[i].vehicle_id !== rows[i - 1].vehicle_id) continue;
        const doneMs = Date.parse(String(rows[i - 1].done_at).replace(' ', 'T') +
          (String(rows[i - 1].done_at).includes('Z') || String(rows[i - 1].done_at).includes('+') ? '' : 'Z'));
        const gap = (Date.parse(rows[i].starts_at) - doneMs) / 3_600_000;
        if (Number.isFinite(gap) && gap >= 0 && gap < 24 * 7) gaps.push(gap);
      }
      if (!gaps.length) return null;
      return Math.round(gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length * 10) / 10;
    }
    case 'no_driver_days':
    case 'repair_days':
    case 'idle_days':
      return dispositionDays(db, key, fromIso, toIso);
    default:
      return null;
  }
}

// Машино-дни по видам за период. «Простой без причины» — дни, не покрытые
// ни рейсом, ни интервалом: считаем перебором по паркам и дням.
function dispositionDays(db, key, fromIso, toIso) {
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  const DAY = 86_400_000;
  if (key !== 'idle_days') {
    const kind = key === 'no_driver_days' ? 'no_driver' : 'repair';
    const rows = db.prepare(`SELECT starts_at, ends_at FROM vehicle_dispositions
      WHERE kind=? AND starts_at<? AND ends_at>?`).all(kind, toIso, fromIso);
    const days = rows.reduce((sum, row) => {
      const a = Math.max(Date.parse(row.starts_at), from);
      const b = Math.min(Date.parse(row.ends_at), to);
      return sum + Math.max(0, b - a) / DAY;
    }, 0);
    return Math.round(days);
  }
  const fleet = db.prepare(`SELECT id FROM vehicles WHERE status='work'`).all();
  const trips = db.prepare(`SELECT vehicle_id, starts_at, ends_at, on_line_at, unloaded_at
    FROM trips WHERE status<>'rejected' AND starts_at<? AND ends_at>?`).all(toIso, fromIso);
  const dispositions = db.prepare(`SELECT vehicle_id, starts_at, ends_at FROM vehicle_dispositions
    WHERE starts_at<? AND ends_at>?`).all(toIso, fromIso);
  let idle = 0;
  const now = Date.now();
  for (const vehicle of fleet) {
    for (let at = from; at < Math.min(to, now); at += DAY) {
      const dayEnd = at + DAY;
      const busy = trips.some(trip => trip.vehicle_id === vehicle.id &&
        Date.parse(trip.starts_at) < dayEnd &&
        (Date.parse(trip.unloaded_at || trip.ends_at)) > at);
      if (busy) continue;
      const covered = dispositions.some(item => item.vehicle_id === vehicle.id &&
        Date.parse(item.starts_at) < dayEnd && Date.parse(item.ends_at) > at);
      if (!covered) idle += 1;
    }
  }
  return idle;
}

// Инициативы проекта: что меняем в продукте и какой ждём эффект.
export function listInitiatives(db, fromIso = null, toIso = null) {
  const rows = db.prepare(`SELECT i.*, u.full_name author FROM project_initiatives i
    LEFT JOIN users u ON u.id=i.created_by
    ORDER BY CASE i.status WHEN 'doing' THEN 0 WHEN 'todo' THEN 1 ELSE 2 END,
      i.sort_order, i.created_at`).all();
  if (!fromIso || !toIso) return rows;
  // Прогресс по измеримым инициативам считается сам: статус вручную нужен
  // только там, где метрики нет.
  return rows.map(row => {
    if (!row.metric_key || !METRICS[row.metric_key]) return row;
    const value = metricValue(db, row.metric_key, fromIso, toIso);
    const meta = METRICS[row.metric_key];
    const target = Number(row.metric_target);
    const reached = value == null || !Number.isFinite(target) ? null
      : meta.dir === 'less' ? value <= target : value >= target;
    return { ...row, metric: { ...meta, value, target, reached } };
  });
}

// Снимок метрик: фиксируем «как было» перед изменением продукта, чтобы
// потом честно сравнить. Без снимка любое улучшение — вопрос веры.
export function takeSnapshot(db, { label, fromIso, toIso, userId }) {
  const payload = {
    handoffs: handoffMetrics(db, fromIso, toIso),
    operations: operationMetrics(db, fromIso, toIso),
    money: moneyMetrics(db, fromIso, toIso)
  };
  const id = `snap-${Date.now().toString(36)}`;
  db.prepare(`INSERT INTO project_snapshots(id,label,period_from,period_to,payload_json,created_by)
    VALUES(?,?,?,?,?,?)`).run(id, String(label || '').slice(0, 160), fromIso, toIso,
    JSON.stringify(payload), userId || null);
  return { id, ...payload };
}

export function listSnapshots(db, limit = 12) {
  return db.prepare(`SELECT id,label,period_from,period_to,payload_json,created_at
    FROM project_snapshots ORDER BY created_at DESC LIMIT ?`).all(limit)
    .map(row => ({ ...row, payload: JSON.parse(row.payload_json) }));
}
