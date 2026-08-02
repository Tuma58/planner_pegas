// Конвейер перевозки: единая модель стадий заявки.
// Действие каждого сотрудника передаёт заявку следующей роли, поэтому карточка
// всегда отвечает на два вопроса: на какой стадии заявка и чей сейчас ход.
export const STAGES = ['Заявка принята', 'Подтверждена', 'Назначена ТС', 'В пути', 'Выгружена', 'Документы'];

// Стадия → кто действует, что делает и каким правом это разрешено.
// kind определяет способ выполнения: confirm/reject — PATCH заявки,
// assign — модалка подбора ТС, trip-status — PATCH статуса рейса.
const STEPS = [
  {
    stage: 0, waitingRole: 'Продажи', permission: 'orders:write',
    action: { label: 'Подтвердить', kind: 'confirm', hint: 'Согласовано с клиентом — передать логисту' }
  },
  {
    stage: 1, waitingRole: 'Логист', permission: 'trips:write',
    action: { label: 'Назначить ТС', kind: 'assign', hint: 'Подобрать сцепку и поставить в план' }
  },
  {
    stage: 2, waitingRole: 'Диспетчер', permission: 'trip-status:write',
    action: { label: 'Отправить в рейс', kind: 'trip-status', status: 'run', hint: 'ТС вышло на маршрут' }
  },
  {
    stage: 3, waitingRole: 'Диспетчер', permission: 'trip-status:write',
    action: { label: 'Отметить выгрузку', kind: 'trip-status', status: 'unloaded', hint: 'Груз выгружен у получателя' }
  },
  {
    stage: 4, waitingRole: 'Бухгалтерия', permission: 'payments:write',
    action: { label: 'Отметить оплату', kind: 'trip-status', status: 'paid', hint: 'Оплата поступила' }
  },
  { stage: 5, waitingRole: null, permission: null, action: null }
];

// Метки CURRENT_TIMESTAMP приходят из SQLite в виде «2026-08-02 18:55:00» — без указания
// зоны. Такую строку браузер считает местным временем, поэтому проставляем UTC явно.
function parseServerTime(value) {
  const text = String(value);
  return Date.parse(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)
    ? `${text.replace(' ', 'T')}Z` : text);
}

// Текущая стадия заявки: у поставленной в план она следует за статусом рейса.
export function orderStage(order, data) {
  if (order.trip_id) {
    const trip = data.trips.find(item => item.id === order.trip_id);
    if (trip) {
      if (trip.status === 'rejected') return { stage: 1, hot: true, plate: trip.vehicle_plate, trip };
      const map = { plan: 2, run: 3, unloaded: 4, done: 4, paid: 5 };
      return { stage: map[trip.status] ?? 2, plate: trip.vehicle_plate, trip };
    }
  }
  return { stage: Number(order.stage) || 0 };
}

// Полное состояние заявки в конвейере для отрисовки карточки.
export function pipelineStep(order, data, can) {
  const current = orderStage(order, data);
  const step = STEPS[Math.min(current.stage, STEPS.length - 1)];
  const mine = Boolean(step.permission && can(step.permission));
  const since = order.stage_changed_at || order.updated_at || order.created_at;
  const sinceMs = since ? Math.max(0, Date.now() - parseServerTime(since)) : 0;

  let tone = 'wait';
  if (order.status === 'cancelled') tone = 'rejected';
  else if (order.returned_at) tone = 'returned';
  else if (!step.waitingRole) tone = 'done';
  else if (mine) tone = 'mine';

  return {
    stage: current.stage,
    label: STAGES[current.stage] || STAGES[0],
    plate: current.plate,
    trip: current.trip,
    hot: current.hot,
    waitingRole: step.waitingRole,
    action: step.action,
    permission: step.permission,
    mine, tone, sinceMs,
    // Отклонить можно, пока рейс не начался: дальше это делается через статус рейса.
    canReject: order.status !== 'cancelled' && current.stage <= 1 &&
      (can('orders:write') || can('trips:write'))
  };
}

// Задачи текущего пользователя — заявки, ожидающие действия с его правами.
export function myTasks(orders, data, can) {
  return orders.filter(order => order.status !== 'cancelled' && pipelineStep(order, data, can).mine);
}

// «висит 3 ч» / «2 дн» — подсказка, где конвейер стоит.
export function waitingLabel(ms) {
  if (!ms || ms < 0) return '';
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return `${Math.max(1, Math.floor(ms / 60_000))} мин`;
  if (hours < 48) return `${hours} ч`;
  return `${Math.floor(hours / 24)} дн`;
}
