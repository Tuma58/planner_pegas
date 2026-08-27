// Телефония и работа с входящими вопросами водителей.
//
// Номера в системе живут в разном виде: «79875105921», «+7 (987) 510-59-21»,
// «8 987 510 59 21». Чтобы находить звонящего, все номера приводятся к
// цифрам и сравниваются по последним десяти — этого достаточно и для
// мобильных, и для городских с кодом.
export function phoneDigits(value) {
  const digits = String(value || '').replace(/\D+/g, '');
  if (!digits) return '';
  // 8XXXXXXXXXX и 7XXXXXXXXXX — один и тот же номер.
  const normalized = digits.length === 11 && (digits[0] === '8' || digits[0] === '7')
    ? `7${digits.slice(1)}` : digits;
  return normalized.slice(-10);
}

export function phonePretty(value) {
  const digits = phoneDigits(value);
  if (digits.length !== 10) return String(value || '');
  return `+7 (${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6, 8)}-${digits.slice(8)}`;
}

// Кто звонит: водитель, сотрудник или контакт клиента. Водитель ищется
// первым — ради него всё и строится.
export function identifyCaller(db, phone) {
  const digits = phoneDigits(phone);
  if (digits.length < 6) return { kind: 'unknown', id: null, name: '', vehicleId: null };
  const like = `%${digits}`;
  const driver = db.prepare(`SELECT d.id, d.full_name, d.phone, d.vehicle_id, v.plate
    FROM drivers d LEFT JOIN vehicles v ON v.id=d.vehicle_id
    WHERE d.status<>'fired' AND REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(d.phone,'+',''),'-',''),' ',''),'(',''),')','') LIKE ?
    LIMIT 1`).get(like);
  if (driver) {
    return { kind: 'driver', id: driver.id, name: driver.full_name,
      vehicleId: driver.vehicle_id, plate: driver.plate || '' };
  }
  const employee = db.prepare(`SELECT id, full_name, job_role FROM users
    WHERE deleted_at IS NULL AND phone<>'' AND
      REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone,'+',''),'-',''),' ',''),'(',''),')','') LIKE ?
    LIMIT 1`).get(like);
  if (employee) {
    return { kind: 'employee', id: employee.id, name: employee.full_name,
      role: employee.job_role || '', vehicleId: null };
  }
  const contact = db.prepare(`SELECT id, full_name, customer_name, position FROM customer_contacts
    WHERE phone<>'' AND
      REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone,'+',''),'-',''),' ',''),'(',''),')','') LIKE ?
    LIMIT 1`).get(like);
  if (contact) {
    return { kind: 'customer', id: contact.id, name: contact.full_name,
      customer: contact.customer_name, vehicleId: null };
  }
  return { kind: 'unknown', id: null, name: '', vehicleId: null };
}

// Темы вопросов — фиксированный список: по нему считается статистика и
// видно, какой шаг подготовки рейса пропущен. «Другое» — на крайний случай,
// его доля должна оставаться маленькой.
export const QUESTION_TOPICS = [
  { key: 'next_task', label: 'Какое следующее задание', owner: 'Логист' },
  { key: 'no_poa', label: 'Нет доверенности', owner: 'Диспетчер' },
  { key: 'no_data_sent', label: 'Данные на водителя и ТС не направлены грузоотправителю', owner: 'Продажи' },
  { key: 'wrong_address', label: 'Не тот адрес', owner: 'Продажи' },
  { key: 'docs_mismatch', label: 'Данные в документах и в задании расходятся', owner: 'Диспетчер' },
  { key: 'service_point', label: 'Где мойка / сервис / стоянка', owner: 'Диспетчер' },
  { key: 'shift', label: 'Когда пересменка', owner: 'Ресурс' },
  { key: 'mechanic', label: 'Как связаться с механиком', owner: 'Ресурс' },
  { key: 'customer_phone', label: 'Нужен телефон клиента', owner: 'Продажи' },
  { key: 'other', label: 'Другое', owner: '' }
];

// Норматив решения вопроса водителя: десять минут. Дальше вопрос считается
// просроченным — карточка краснеет и уходит сигнал смене.
export const QUESTION_SLA_MS = 10 * 60_000;

export function listDriverQuestions(db, { openOnly = false, sinceIso = null } = {}) {
  const where = [];
  if (openOnly) where.push('q.closed_at IS NULL');
  if (sinceIso) where.push(`q.opened_at>='${sinceIso.replace(/'/g, '')}'`);
  return db.prepare(`SELECT q.*, v.plate vehicle_plate, v.driver_name vehicle_driver,
      u1.full_name opened_by_name, u2.full_name closed_by_name
    FROM driver_questions q
    LEFT JOIN vehicles v ON v.id=q.vehicle_id
    LEFT JOIN users u1 ON u1.id=q.opened_by
    LEFT JOIN users u2 ON u2.id=q.closed_by
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY q.closed_at IS NOT NULL, q.opened_at DESC`).all();
}

// Сторож норматива: вопрос висит дольше десяти минут — один раз поднимаем
// тревогу смене. Повторно не дёргаем: карточка и так горит в списке.
export function checkQuestionSla(db, nowMs = Date.now()) {
  const overdue = db.prepare(`SELECT q.*, v.plate vehicle_plate FROM driver_questions q
    LEFT JOIN vehicles v ON v.id=q.vehicle_id
    WHERE q.closed_at IS NULL AND q.escalated_at IS NULL`).all()
    .filter(item => nowMs - Date.parse(String(item.opened_at).replace(' ', 'T') +
      (String(item.opened_at).includes('Z') ? '' : 'Z')) > QUESTION_SLA_MS);
  const stamp = new Date(nowMs).toISOString();
  for (const item of overdue) {
    db.prepare('UPDATE driver_questions SET escalated_at=? WHERE id=?').run(stamp, item.id);
  }
  return overdue;
}

// Сводка по темам за период: что чаще всего спрашивают, сколько решаем и
// укладываемся ли в норматив. Это и есть список процессов, которые чинить.
export function questionStats(db, fromIso, toIso) {
  const rows = db.prepare(`SELECT topic, opened_at, closed_at FROM driver_questions
    WHERE opened_at>=? AND opened_at<?`).all(fromIso, toIso);
  const ts = value => Date.parse(String(value).replace(' ', 'T') +
    (String(value).includes('Z') ? '' : 'Z'));
  const byTopic = new Map();
  for (const row of rows) {
    const item = byTopic.get(row.topic) || { topic: row.topic, total: 0, closed: 0, inSla: 0, times: [] };
    item.total += 1;
    if (row.closed_at) {
      const ms = ts(row.closed_at) - ts(row.opened_at);
      item.closed += 1;
      item.times.push(ms);
      if (ms <= QUESTION_SLA_MS) item.inSla += 1;
    }
    byTopic.set(row.topic, item);
  }
  const median = list => {
    if (!list.length) return 0;
    const sorted = [...list].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  };
  return [...byTopic.values()].map(item => ({
    topic: item.topic,
    label: QUESTION_TOPICS.find(topic => topic.key === item.topic)?.label || item.topic,
    owner: QUESTION_TOPICS.find(topic => topic.key === item.topic)?.owner || '',
    total: item.total, closed: item.closed,
    medianMs: median(item.times),
    slaPct: item.closed ? Math.round(item.inSla / item.closed * 100) : 0
  })).sort((a, b) => b.total - a.total);
}
