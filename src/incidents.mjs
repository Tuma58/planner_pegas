// ── Блок «Внештатки и возвраты», этап 1 (план docs/returns-plan.md) ──
// Заявка Базуева из HELP DESK 02.11, «делаем Э1» руководителя 03.11.
// Ручные инциденты (акт на выгрузке, возврат продукции, опоздание без
// отметок) заводит диспетчер из меню внештатной ситуации; опоздания с
// отметками во вкладку попадают АВТОМАТОМ из trip_stops — живой контур
// не дублируется руками (канон). Цепочка статусов возврата и склады
// LTL — этап 2; словарь статусов заложен в схему с запасом.

export const INCIDENT_KINDS = {
  act: 'Акт на выгрузке',
  return: 'Возврат продукции',
  late: 'Опоздание'
};

// Инциденты периода: ручные (trip_incidents) + авто-опоздания из
// отметок (факт прибытия позже плана больше часа — тот же порог, что
// в отчётах опозданий).
export function incidentsData(db, fromIso, toIso) {
  const manual = db.prepare(`SELECT i.*, v.plate vehicle_plate, t.customer_name,
      t.from_point, t.to_point,
      (SELECT o.order_no FROM orders o WHERE o.id=t.order_id) order_no
    FROM trip_incidents i
    JOIN trips t ON t.id=i.trip_id
    JOIN vehicles v ON v.id=t.vehicle_id
    WHERE datetime(i.created_at) >= datetime(?) AND datetime(i.created_at) < datetime(?)
    ORDER BY i.created_at DESC LIMIT 500`).all(fromIso, toIso);
  // Опозданий >1 ч за месяц — сотни: наверх крупнейшие (они и есть
  // боль), общий счётчик — строкой на вкладке.
  const lateWhere = `s.actual_arrival IS NOT NULL AND s.planned_arrival IS NOT NULL
      AND julianday(s.actual_arrival) - julianday(s.planned_arrival) > 1.0/24
      AND datetime(s.actual_arrival) >= datetime(?) AND datetime(s.actual_arrival) < datetime(?)`;
  const autoLate = db.prepare(`SELECT s.trip_id, s.kind stop_kind, s.point,
      s.planned_arrival, s.actual_arrival, v.plate vehicle_plate, t.customer_name,
      t.from_point, t.to_point,
      (SELECT o.order_no FROM orders o WHERE o.id=t.order_id) order_no,
      ROUND((julianday(s.actual_arrival) - julianday(s.planned_arrival)) * 24, 1) late_hours
    FROM trip_stops s
    JOIN trips t ON t.id=s.trip_id
    JOIN vehicles v ON v.id=t.vehicle_id
    WHERE ${lateWhere}
    ORDER BY late_hours DESC LIMIT 50`).all(fromIso, toIso);
  const autoLateTotal = db.prepare(`SELECT COUNT(*) c FROM trip_stops s
    JOIN trips t ON t.id=s.trip_id WHERE ${lateWhere}`).get(fromIso, toIso).c;
  return { manual, autoLate, autoLateTotal };
}

// ── Э2: цепочка статусов возврата ──
// ТЗ Базуева: два измерения одновременно — РЕШЕНИЕ (статус) × ГДЕ ЛЕЖИТ
// (warehouse: пусто = на борту, иначе склад LTL из справочника).
// Терминальные статусы (осуществлён/утилизация) уводят возврат в архив
// и требуют итога — история решений не бывает молчаливой.
export const RETURN_STATUSES = {
  open: 'возврат загрузили',
  wait_decision: 'ждём решения клиента',
  returned: 'возврат осуществлён',
  utilized: 'утилизация'
};

export function returnStatusChange(incident, status, warehouse = '', resolution = '') {
  if (!incident || incident.kind !== 'return') return { error: 'Цепочка статусов — только у возвратов' };
  if (incident.closed_at) return { error: 'Возврат уже в архиве' };
  if (!RETURN_STATUSES[status]) return { error: 'Неизвестный статус возврата' };
  const terminal = status === 'returned' || status === 'utilized';
  const note = String(resolution || '').trim().slice(0, 500);
  if (terminal && !note) return { error: 'Закрытие возврата — только с итогом: куда делся груз' };
  // Пустой склад = «не менять»: терминальный статус не стирает, где
  // груз лежал, — это часть истории возврата.
  const place = String(warehouse || '').trim().slice(0, 120);
  return { patch: {
    status,
    warehouse: place || String(incident.warehouse || ''),
    resolution: note,
    terminal
  } };
}

// Живой норматив решения возврата: медиана дней «создан → закрыт» по
// закрытым возвратам (мин 5 образцов), кламп 2–14 дн, фолбэк 5 дн.
export function returnStuckDays(db) {
  const days = db.prepare(`SELECT (julianday(closed_at) - julianday(created_at)) d
      FROM trip_incidents WHERE kind='return' AND closed_at IS NOT NULL
      ORDER BY d`).all().map(row => row.d).filter(value => value > 0);
  if (days.length < 5) return 5;
  const median = days[Math.floor(days.length / 2)];
  return Math.min(14, Math.max(2, Math.round(median)));
}

// Зависшие возвраты: открытые дольше норматива и не напомненные за сутки.
export function returnsStuck(db, stuckDays) {
  return db.prepare(`SELECT i.*, v.plate vehicle_plate, t.customer_name
    FROM trip_incidents i
    JOIN trips t ON t.id=i.trip_id
    JOIN vehicles v ON v.id=t.vehicle_id
    WHERE i.kind='return' AND i.closed_at IS NULL
      AND julianday('now') - julianday(i.created_at) > ?
      AND (i.reminded_at IS NULL OR datetime(i.reminded_at) < datetime('now','-1 day'))
    ORDER BY i.created_at`).all(stuckDays);
}

// ── Э3: сводка внештаток — для «⚡ Сводки периода», утреннего отчёта
// и вестника. Создано за период по типам + возвраты, закрытые за
// период, + открытые возвраты СЕЙЧАС (с возрастом, старшие первыми).
export function incidentsSummary(db, fromIso, toIso) {
  const counts = { act: 0, return: 0, late: 0 };
  for (const row of db.prepare(`SELECT kind, COUNT(*) c FROM trip_incidents
      WHERE datetime(created_at) >= datetime(?) AND datetime(created_at) < datetime(?)
      GROUP BY kind`).all(fromIso, toIso)) counts[row.kind] = row.c;
  const returnsClosed = db.prepare(`SELECT COUNT(*) c FROM trip_incidents
    WHERE kind='return' AND closed_at IS NOT NULL
      AND datetime(closed_at) >= datetime(?) AND datetime(closed_at) < datetime(?)`)
    .get(fromIso, toIso).c;
  const openReturns = db.prepare(`SELECT i.qty, i.warehouse, v.plate, t.customer_name,
      ROUND(julianday('now') - julianday(i.created_at), 1) age_days
    FROM trip_incidents i
    JOIN trips t ON t.id=i.trip_id
    JOIN vehicles v ON v.id=t.vehicle_id
    WHERE i.kind='return' AND i.closed_at IS NULL
    ORDER BY i.created_at LIMIT 20`).all();
  return { counts, returnsClosed, openReturns };
}

// Текст уведомления о новом инциденте — продажам (их клиент) и
// руководителю, одной строкой с сутью.
export function incidentNotifyText(kind, trip, qty, comment) {
  const icon = kind === 'act' ? '📋' : kind === 'return' ? '↩' : '⏰';
  const head = `${icon} ${INCIDENT_KINDS[kind] || kind}: ` +
    `${trip.order_no ? `заявка № ${trip.order_no} ` : ''}(${trip.plate}, ${trip.customer_name || 'клиент не указан'})`;
  const tail = [qty && `кол-во: ${qty}`, comment].filter(Boolean).join(' · ');
  return `${head}${tail ? ` — ${tail}` : ''}. Карточка — во вкладке «⚠ Внештатки»`;
}
