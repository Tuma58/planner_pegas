// Адаптер Облачной АТС Билайн.
//
// Билайн даёт два механизма (см. docs/telephony-beeline.md):
//  1. Статистика звонков — GET /apis/portal/statistics?page=N&pageSize=M.
//     Журнал завершённых звонков, новые сверху: направление (INBOUND/OUTBOUND),
//     номер второй стороны, статус (MISSED/RECIEVED/PLACED), длительность,
//     наш сотрудник (abonent). Это опорный контур: опрашивается сторожем и
//     наполняет call_events — пропущенные звонки поднимают карточку.
//  2. Xsi-Events — PUT /apis/portal/subscription, события приходят XML'ом на
//     наш callback-URL в реальном времени (звонок начался/ответ/завершён).
//     Нужен публичный HTTPS-адрес; подписка живёт ограниченное время и
//     продлевается.
//
// Аутентификация: заголовок X-MPBX-API-AUTH-TOKEN (токен из настроек АТС).
// Токен хранится в .secrets/beeline_ats_token и читается через config.mjs.

import { createHash } from 'node:crypto';
import { phoneDigits } from './telephony.mjs';

export const BEELINE_BASE_URL = 'https://cloudpbx.beeline.ru/apis/portal';
export const BEELINE_TOKEN_HEADER = 'X-MPBX-API-AUTH-TOKEN';

// HTTP-клиент Билайна. fetchImpl — внедряется тестами; по умолчанию глобальный
// fetch (Node ≥ 22). Возвращает распарсенный JSON или null, когда провайдер
// ничего не отдал.
export async function beelineGet(path, { token, baseUrl = BEELINE_BASE_URL, fetchImpl } = {}) {
  if (!token) throw new Error('Токен АТС Билайн не задан (BEELINE_ATS_TOKEN)');
  const doFetch = fetchImpl || fetch;
  const response = await doFetch(`${baseUrl}${path}`, {
    headers: { [BEELINE_TOKEN_HEADER]: token, Accept: 'application/json' }
  });
  if (!response.ok) {
    const text = String(response.statusText || '').slice(0, 160);
    throw new Error(`Билайн API ${response.status}${text ? `: ${text}` : ''}`);
  }
  const body = await response.json().catch(() => null);
  return body;
}

// Детерминированный ключ события для дедупликации. В статистике нет своего id,
// поэтому ключ — хэш от времени, второй стороны, нашего сотрудника, направления
// и статуса. Один и тот же звонок при повторном опросе не создаёт дубль.
export function callExternalId(item) {
  const abonent = item?.abonent || {};
  const raw = [item?.startDate, item?.phone, abonent.userId, item?.direction, item?.status]
    .map(value => value ?? '').join('|');
  return createHash('sha1').update(raw).digest('hex').slice(0, 24);
}

// Наш сотрудник по телефону (для target_user_id входящего): ищем в users по
// последним десяти цифрам — тот же приём, что в вебхуке АТС.
export function findUserByPhone(db, phone) {
  const digits = phoneDigits(phone);
  if (digits.length < 6) return null;
  return db.prepare(`SELECT id FROM users
    WHERE deleted_at IS NULL AND phone<>'' AND
      REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone,'+',''),'-',''),' ',''),'(',''),')','') LIKE ?
    LIMIT 1`).get(`%${digits}`)?.id || null;
}

// Преобразование строки статистики Билайна в событие call_events.
// identify — identifyCaller(db, phone) из telephony.mjs (водитель → сотрудник →
// контакт клиента). Возвращает поля строки call_events.
export function mapBeelineCall(item, { identify, findUser } = {}) {
  const abonent = item?.abonent || {};
  const direction = String(item?.direction).toUpperCase() === 'OUTBOUND' ? 'out' : 'in';
  const externalPhone = String(item?.phone || '');
  const employeePhone = String(abonent.phone || '');
  // Входящий: звонит внешний номер, принимает наш сотрудник. Исходящий — наоборот.
  const fromPhone = direction === 'in' ? externalPhone : employeePhone;
  const toPhone = direction === 'in' ? employeePhone : externalPhone;
  const caller = identify ? identify(fromPhone) : { kind: 'unknown', id: null, name: '', vehicleId: null };
  return {
    provider: 'beeline',
    external_id: callExternalId(item),
    direction,
    from_phone: fromPhone,
    to_phone: toPhone,
    from_digits: phoneDigits(fromPhone),
    matched_kind: caller.kind || 'unknown',
    matched_id: caller.id || null,
    matched_name: caller.name || '',
    vehicle_id: caller.vehicleId || null,
    target_user_id: direction === 'in' && findUser ? findUser(employeePhone) : null,
    started_at: Number.isFinite(item?.startDate) ? new Date(item.startDate).toISOString() : null,
    status: String(item?.status || ''),
    duration_ms: Number.isFinite(item?.duration) ? Number(item.duration) : null,
    employee_phone: employeePhone
  };
}

// Синхронизация журнала звонков: опрос статистики Билайна и запись новых
// событий в call_events. Дедупликация — по внешнему ключу (provider + external_id
// с уникальным индексом). Возвращает сводку для лога сторожа.
export async function syncBeelineCalls(db, { token, baseUrl, fetchImpl, identify, nowMs = Date.now() } = {}) {
  const rows = await beelineGet('/statistics?page=1&pageSize=100', { token, baseUrl, fetchImpl });
  if (!Array.isArray(rows)) return { added: 0, skipped: 0, latest: null };
  const horizon = nowMs - 24 * 3_600_000;
  const insert = db.prepare(`INSERT OR IGNORE INTO call_events(
      provider,external_id,direction,from_phone,to_phone,from_digits,
      matched_kind,matched_id,matched_name,vehicle_id,target_user_id,
      started_at,status,duration_ms,employee_phone)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  let added = 0;
  let skipped = 0;
  let latest = null;
  for (const item of rows) {
    // Старые хвосты не тянем: журнал опрашивается каждую минуту, а
    // дедупликация и так не даст дублей, но лишние строки не нужны.
    if (Number.isFinite(item?.startDate) && item.startDate < horizon) continue;
    const row = mapBeelineCall(item, { identify, findUser: phone => findUserByPhone(db, phone) });
    const started = row.started_at || new Date().toISOString();
    if (!latest || started > latest) latest = started;
    const result = insert.run(
      row.provider, row.external_id, row.direction, row.from_phone, row.to_phone, row.from_digits,
      row.matched_kind, row.matched_id, row.matched_name, row.vehicle_id, row.target_user_id,
      started, row.status, row.duration_ms, row.employee_phone);
    if (result.changes > 0) added += 1; else skipped += 1;
  }
  return { added, skipped, latest };
}

// ── Xsi-Events: подписка на события в реальном времени ──
// Публичный адрес нашего приложения + токен → подписка на BASIC_CALL.
// Подписка возвращает subscriptionId и срок жизни (expires, секунды);
// её нужно продлевать до истечения. Управление хранится в app_meta.
export function subscriptionMeta(db) {
  const row = db.prepare(`SELECT value FROM app_meta WHERE key='beeline_subscription'`).get();
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}

export function saveSubscriptionMeta(db, meta) {
  db.prepare(`INSERT INTO app_meta(key,value) VALUES('beeline_subscription',?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(JSON.stringify(meta));
}

// Создание/продление подписки. pattern — номер/добавочный, за которым следим
// (пусто — не подписываемся). Возвращает null, когда подписка не нужна или
// провайдер её не принял.
export async function ensureBeelineSubscription(db, { token, baseUrl, fetchImpl, publicBase, pattern, nowMs = Date.now() } = {}) {
  if (!publicBase || !pattern || !token) return null;
  const callbackUrl = `${String(publicBase).replace(/\/+$/, '')}/api/telephony/beeline/events`;
  const current = subscriptionMeta(db);
  if (current && Number(current.expires) > nowMs + 10 * 60_000) return current;
  const doFetch = fetchImpl || fetch;
  const response = await doFetch(`${baseUrl}/subscription`, {
    method: 'PUT',
    headers: { [BEELINE_TOKEN_HEADER]: token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ pattern, expires: 3600, subscriptionType: 'BASIC_CALL', url: callbackUrl })
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Подписка Билайн: ${response.status} ${text.slice(0, 160)}`);
  }
  const meta = await response.json().catch(() => null);
  if (!meta?.subscriptionId) return null;
  const saved = {
    subscriptionId: meta.subscriptionId,
    expires: nowMs + (Number(meta.expires) || 3600) * 1000,
    pattern, url: callbackUrl
  };
  saveSubscriptionMeta(db, saved);
  return saved;
}

// Разбор события Xsi-Events (BroadWorks). Формат — XML; здесь берём только то,
// что нужно карточке звонка: направление, номера сторон и id звонка. Парсер
// защитный: нераспознанный XML не роняет приём — событие игнорируется.
export function parseXsiEvent(raw) {
  const text = String(raw || '');
  if (!text) return null;
  const lower = text.toLowerCase();
  const eventType = lower.includes('callreceivedevent') ? 'received'
    : lower.includes('calloriginatedevent') ? 'originated'
    : lower.includes('callansweredevent') ? 'answered'
    : lower.includes('callreleasedevent') ? 'released'
    : lower.includes('callredirectedevent') ? 'redirected'
    : '';
  if (!eventType) return null;
  const grab = regex => {
    const match = text.match(regex);
    return match ? match[1].trim() : '';
  };
  const callId = grab(/<xsi:callid>([^<]+)<\/xsi:callid>/i) || grab(/<callid>([^<]+)<\/callid>/i);
  // Номера сторон: addressOfRecord (sip) и tel-URI; собираем все, чтобы
  // отделить внешнего от нашего (нашего знает identifyCaller по справочнику).
  const numbers = new Set();
  for (const match of text.matchAll(/<xsi:addressofrecord>([^<]+)<\/xsi:addressofrecord>/gi)) {
    numbers.add(match[1]);
  }
  for (const match of text.matchAll(/tel:([+0-9]{6,})/gi)) {
    numbers.add(match[1]);
  }
  const digits = [...numbers].map(phoneDigits).filter(d => d.length >= 6);
  const direction = eventType === 'originated' ? 'out' : 'in';
  const from = digits[0] || '';
  const to = digits[1] || '';
  return { eventType, callId, direction, from, to, digits };
}
