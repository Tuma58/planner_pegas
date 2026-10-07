// Адаптер Облачной АТС Билайн.
//
// Проверено реальным токеном (см. docs/telephony-beeline.md):
//  - GET /statistics?page=N&pageSize=M — журнал звонков, новые сверху. Даёт
//    направление (INBOUND/OUTBOUND), статус (MISSED/RECIEVED/PLACED),
//    длительность и НАШЕГО сотрудника (abonent). ВАЖНО: поле `phone` здесь
//    равно мобильному (FMC) номеру нашего сотрудника, а НЕ второй стороне —
//    номер звонящего статистика не отдаёт.
//  - GET /abonents — справочник сотрудников АТС (userId/phone/extension).
//  - PUT /subscription — подписка Xsi-Events: события звонков приходят XML'ом
//    на наш callback-URL В МОМЕНТ звонка (received/originated/answered/
//    released), и именно они несут номер звонящего. Подписка — на каждого
//    сотрудника (targetType ABONENT), живёт ограниченное время (expires),
//    продлевается.
//
// Поэтому: номер звонящего и всплытие карточки даёт ТОЛЬКО Xsi-Events;
// статистика наполняет журнал (кто/когда/пропущен/длительность) без номера.
//
// Аутентификация: заголовок X-MPBX-API-AUTH-TOKEN (токен .secrets/
// beeline_ats_token → config.beelineAtsToken).

import { createHash, randomUUID } from 'node:crypto';
import { phoneDigits } from './telephony.mjs';

export const BEELINE_BASE_URL = 'https://cloudpbx.beeline.ru/apis/portal';
export const BEELINE_TOKEN_HEADER = 'X-MPBX-API-AUTH-TOKEN';

// HTTP-клиент Билайна. fetchImpl внедряется тестами (по умолчанию глобальный
// fetch, Node ≥ 22). Не-HTTP-статус бросает ошибку.
export async function beelineGet(path, { token, baseUrl = BEELINE_BASE_URL, fetchImpl } = {}) {
  if (!token) throw new Error('Токен АТС Билайн не задан (BEELINE_ATS_TOKEN)');
  const doFetch = fetchImpl || fetch;
  const response = await doFetch(`${baseUrl}${path}`, {
    headers: { [BEELINE_TOKEN_HEADER]: token, Accept: 'application/json' }
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Билайн API ${response.status}: ${String(text).slice(0, 160)}`);
  }
  return response.json().catch(() => null);
}

// Детерминированный ключ события журнала для дедупликации: в статистике нет
// своего id, поэтому ключ — хэш от времени, сотрудника, направления и статуса.
export function callExternalId(item) {
  const abonent = item?.abonent || {};
  const raw = [item?.startDate, item?.direction, item?.status, abonent.userId, abonent.extension]
    .map(value => value ?? '').join('|');
  return createHash('sha1').update(raw).digest('hex').slice(0, 24);
}

// Наш сотрудник по телефону (target_user_id): ищем в users по последним десяти
// цифрам — тот же приём, что в вебхуке АТС.
export function findUserByPhone(db, phone) {
  const digits = phoneDigits(phone);
  if (digits.length < 2) return null;
  const norm = column => `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(${column},'+',''),'-',''),' ',''),'(',''),')','')`;
  // Рабочий телефон текущей смены главнее постоянных: дежурная трубка
  // переезжает между сотрудниками, и карточка должна всплыть у того,
  // кто внёс её номер при входе сегодня. Затем добавочный АТС из
  // карточки сотрудника, затем личный мобильный.
  for (const column of ['work_phone', 'ext_phone', 'phone']) {
    // Короткий добавочный (меньше 7 цифр) — только точное совпадение:
    // хвостовой LIKE ловил бы чужие номера с тем же окончанием.
    const row = digits.length < 7
      ? db.prepare(`SELECT id FROM users WHERE deleted_at IS NULL AND active=1
          AND ${column}<>'' AND ${norm(column)}=? LIMIT 1`).get(digits)
      : db.prepare(`SELECT id FROM users WHERE deleted_at IS NULL AND active=1
          AND ${column}<>'' AND ${norm(column)} LIKE ? LIMIT 1`).get(`%${digits}`);
    if (row) return row.id;
  }
  return null;
}

// Строка статистики → запись журнала call_events. Номера второй стороны нет,
// поэтому from_phone пуст и звонящий «unknown»; событие помечается разобранным
// (handled_at), чтобы не поднимать карточку «номер не найден». Всплытие с
// номером даёт Xsi-Events.
export function mapStatisticsCall(item, { findUser } = {}) {
  const abonent = item?.abonent || {};
  const direction = String(item?.direction).toUpperCase() === 'OUTBOUND' ? 'out' : 'in';
  const employeePhone = String(abonent.phone || '');
  return {
    provider: 'beeline',
    external_id: callExternalId(item),
    direction,
    from_phone: '',
    to_phone: '',
    from_digits: '',
    matched_kind: 'unknown',
    matched_id: null,
    matched_name: '',
    vehicle_id: null,
    target_user_id: direction === 'in' && findUser ? findUser(employeePhone) : null,
    started_at: Number.isFinite(item?.startDate) ? new Date(item.startDate).toISOString() : null,
    status: String(item?.status || ''),
    duration_ms: Number.isFinite(item?.duration) ? Number(item.duration) : null,
    employee_phone: employeePhone,
    handled_at: new Date().toISOString()
  };
}

// Синхронизация журнала: опрос статистики и запись новых звонков в call_events.
// Дедуп по provider+external_id. Возвращает сводку для лога сторожа.
export async function syncBeelineJournal(db, { token, baseUrl, fetchImpl, nowMs = Date.now() } = {}) {
  const rows = await beelineGet('/statistics?page=1&pageSize=100', { token, baseUrl, fetchImpl });
  if (!Array.isArray(rows)) return { added: 0, skipped: 0, latest: null };
  const horizon = nowMs - 24 * 3_600_000;
  const insert = db.prepare(`INSERT OR IGNORE INTO call_events(
      id,provider,external_id,direction,from_phone,to_phone,from_digits,
      matched_kind,matched_id,matched_name,vehicle_id,target_user_id,
      started_at,status,duration_ms,employee_phone,handled_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  let added = 0;
  let skipped = 0;
  let latest = null;
  for (const item of rows) {
    if (Number.isFinite(item?.startDate) && item.startDate < horizon) continue;
    const row = mapStatisticsCall(item, { findUser: phone => findUserByPhone(db, phone) });
    const started = row.started_at || new Date().toISOString();
    if (!latest || started > latest) latest = started;
    const result = insert.run(
      randomUUID(), row.provider, row.external_id, row.direction, row.from_phone, row.to_phone, row.from_digits,
      row.matched_kind, row.matched_id, row.matched_name, row.vehicle_id, row.target_user_id,
      started, row.status, row.duration_ms, row.employee_phone, row.handled_at);
    if (result.changes > 0) added += 1; else skipped += 1;
  }
  return { added, skipped, latest };
}

// ── Xsi-Events: подписка на события звонков в реальном времени ──
// Подписка одна на сотрудника (pattern = добавочный или номер). Живёт
// ограниченное время (expires, секунды) и продлевается. Состояние подписок —
// в app_meta (карта pattern → {subscriptionId, expires}).
export function subscriptionsMeta(db) {
  const row = db.prepare(`SELECT value FROM app_meta WHERE key='beeline_subscriptions'`).get();
  if (!row) return {};
  try { return JSON.parse(row.value); } catch { return {}; }
}

export function saveSubscriptionsMeta(db, meta) {
  db.prepare(`INSERT INTO app_meta(key,value) VALUES('beeline_subscriptions',?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(JSON.stringify(meta));
}

// Создаёт одну подписку через портал. Возвращает {subscriptionId, expiresMs}.
async function createSubscription({ token, baseUrl = BEELINE_BASE_URL, fetchImpl, pattern, callbackUrl }) {
  const doFetch = fetchImpl || fetch;
  const response = await doFetch(`${baseUrl}/subscription`, {
    method: 'PUT',
    headers: { [BEELINE_TOKEN_HEADER]: token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ pattern, expires: 3600, subscriptionType: 'BASIC_CALL', url: callbackUrl })
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Подписка Билайн (${pattern}): ${response.status} ${String(text).slice(0, 160)}`);
  }
  const meta = await response.json().catch(() => null);
  if (!meta?.subscriptionId) return null;
  return { subscriptionId: meta.subscriptionId, expiresMs: Date.now() + (Number(meta.expires) || 3600) * 1000 };
}

// Обеспечивает подписки на всех сотрудников АТС: создаёт отсутствующие,
// продлевает истекающие. Требует публичный адрес приложения.
export async function ensureBeelineSubscriptions(db, { token, baseUrl, fetchImpl, publicBase, nowMs = Date.now() } = {}) {
  if (!publicBase || !token) return { created: 0, renewed: 0, active: 0 };
  const abonents = await beelineGet('/abonents', { token, baseUrl, fetchImpl });
  if (!Array.isArray(abonents)) return { created: 0, renewed: 0, active: 0 };
  const callbackUrl = `${String(publicBase).replace(/\/+$/, '')}/api/telephony/beeline/events`;
  const current = subscriptionsMeta(db);
  let created = 0;
  let renewed = 0;
  // Карта «подписка → мобильный абонента» для адресации входящих.
  const abonMap = {};
  for (const abonent of abonents) {
    const key = String(abonent.extension || abonent.phone || '');
    if (key) abonMap[key] = { phone: String(abonent.phone || ''), userId: String(abonent.userId || '') };
  }
  const prevAbon = db.prepare(`SELECT value FROM app_meta WHERE key='beeline_abonents'`).get()?.value;
  const nextAbon = JSON.stringify(abonMap);
  if (prevAbon !== nextAbon) {
    db.prepare(`INSERT INTO app_meta(key,value) VALUES('beeline_abonents',?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(nextAbon);
  }
  for (const abonent of abonents) {
    const pattern = String(abonent.extension || abonent.phone || '');
    if (!pattern) continue;
    const existing = current[pattern];
    if (existing && Number(existing.expires) > nowMs + 10 * 60_000) continue;
    try {
      const sub = await createSubscription({ token, baseUrl, fetchImpl, pattern, callbackUrl });
      if (!sub) continue;
      current[pattern] = { subscriptionId: sub.subscriptionId, expires: sub.expiresMs, url: callbackUrl };
      if (existing) renewed += 1; else created += 1;
    } catch (error) {
      console.error(`Подписка Билайн (${pattern}):`, error.message);
    }
  }
  saveSubscriptionsMeta(db, current);
  return { created, renewed, active: Object.keys(current).length };
}

// ── Разбор события Xsi-Events (BroadWorks) ──
// События приходят XML'ом. Берём только нужное карточке: направление, номер
// звонящего и id звонка. Парсер защитный: нераспознанный XML игнорируется.
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
  // Конверт события несёт id подписки — а подписка оформлена на
  // КОНКРЕТНОГО абонента: это единственный надёжный способ понять, кому
  // звонят (своего номера «to» Билайн в событии почти никогда не шлёт —
  // разбор 07.10: 447 из 451 событий с пустым to).
  const subscriptionId = grab(/<xsi:subscriptionid>([^<]+)<\/xsi:subscriptionid>/i)
    || grab(/<subscriptionid>([^<]+)<\/subscriptionid>/i);
  const numbers = new Set();
  for (const match of text.matchAll(/<xsi:addressofrecord>([^<]+)<\/xsi:addressofrecord>/gi)) {
    numbers.add(match[1]);
  }
  for (const match of text.matchAll(/tel:([+0-9]{6,})/gi)) {
    numbers.add(match[1]);
  }
  const digits = [...numbers].map(phoneDigits).filter(d => d.length >= 6);
  const direction = eventType === 'originated' ? 'out' : 'in';
  return { eventType, callId, direction, subscriptionId,
    from: digits[0] || '', to: digits[1] || '', digits };
}

// Карта абонентов АТС (extension/номер подписки → FMC-мобильный):
// обновляется каждым прогоном ensureBeelineSubscriptions, читается при
// событии, чтобы найти сотрудника-адресата по его мобильному.
export function abonentsMeta(db) {
  const row = db.prepare(`SELECT value FROM app_meta WHERE key='beeline_abonents'`).get();
  if (!row) return {};
  try { return JSON.parse(row.value); } catch { return {}; }
}

// Адресат события по id подписки: добавочный (pattern) + мобильный
// абонента из карты. Сопоставление с сотрудником делает вызывающий.
export function resolveSubscriptionTarget(db, subscriptionId) {
  if (!subscriptionId) return null;
  const subs = subscriptionsMeta(db);
  const pattern = Object.keys(subs)
    .find(key => subs[key]?.subscriptionId === subscriptionId);
  if (!pattern) return null;
  return { pattern, phone: abonentsMeta(db)[pattern]?.phone || '' };
}
