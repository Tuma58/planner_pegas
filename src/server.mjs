import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config } from './config.mjs';
import { audit, nextOrderNo, nextRouteNo, openDatabase, queueOutbox, roadKm, settingsObject } from './db.mjs';
import { request as httpsRequest } from 'node:https';
import { ipInSubnets, normalizeAllowedSubnets } from './network-access.mjs';
import { INLINE_TYPES, MAX_FILES_PER_ORDER, MAX_UPLOAD_BYTES, cleanFileName, uploadMimeOf, uploadsPath } from './uploads.mjs';
import { ROLE_LABELS, effectivePermissions, hasPermission, permissionsForRoles, roleLabelsFor, rolesOf } from './permissions.mjs';
import { QUESTION_TOPICS, checkQuestionSla, identifyCaller, listDriverQuestions,
  phoneDigits, phonePretty, questionStats } from './telephony.mjs';
import { METRICS, handoffMetrics, listInitiatives, listSnapshots, moneyMetrics,
  operationMetrics, takeSnapshot } from './project160.mjs';
import {
  encryptSecret, hashPassword, newSessionToken, parseCookies, tokenHash, verifyPassword
} from './security.mjs';
import { processOutbox, runPull, startIntegrationScheduler, testConnection } from './odata.mjs';
import {
  ABSENCE_REASONS, attendanceEffective, attendanceSummary, attendanceTimesheet, chatGroups, chatMessages, createDriverAssignment, customerCard, demurrageCases, demurrageSettings, demurrageSummary, driverCardData, driverScheduleData, importTelematics, importTripsFrom1C, markAttendance,
  reportSnapshot, resolveZone, staffReport, transitHours, tripBusyRange, tripsWithoutNext, upcomingCustomerDates, vehicleUtilization,
  currentShift, shiftReport, deliveryPlan, seedDeliverySlots, myShiftStats, driverRatings
} from './planner-service.mjs';
import {
  DISPATCH_STEPS, applyDispatchStep, checkStuckUnloading, controlSnapshot, ensureTripStops,
  listTripStops, rescheduleTripStops, resetDriverNotificationOnVehicleChange, stampStopsFromStatus,
  backToPreparationOnVehicleChange, tripHasMovementFacts,
  stopsWithEstimates, syncTripFromStops, syncTripStopsWithVia, tripDelayMs
} from './trip-control.mjs';

const db = openDatabase(config.databasePath, config.admin, {
  initialAllowedSubnets: config.initialAllowedSubnets
});
if (config.embeddedSyncWorker) startIntegrationScheduler(db, config.appSecret);
const loginAttempts = new Map();

const json = (response, status, data, extraHeaders = {}) => {
  const body = JSON.stringify(data);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders
  });
  response.end(body);
};

const errorJson = (response, status, message, details) =>
  json(response, status, { error: message, ...(details ? { details } : {}) });

function trustedForwarding(request) {
  const peer = request.socket.remoteAddress || '';
  const loopback = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
  return config.trustProxy || loopback;
}

function requestIp(request) {
  const peer = request.socket.remoteAddress || '';
  const forwarded = trustedForwarding(request)
    ? String(request.headers['x-real-ip'] || '').split(',')[0].trim() : '';
  return forwarded && /^[0-9a-f:.]{3,64}$/i.test(forwarded) ? forwarded : peer;
}

function networkAccessAllowed(request, pathname) {
  const peer = request.socket.remoteAddress || '';
  if (pathname === '/api/health' && !request.headers['x-real-ip'] &&
      ipInSubnets(peer, ['127.0.0.1/32', '::1/128'])) return true;
  const allowedSubnets = settingsObject(db).networkAccess?.allowedSubnets || [];
  return ipInSubnets(requestIp(request), allowedSubnets);
}

function plannerSettings() {
  const { networkAccess: _networkAccess, telephony, ...settings } = settingsObject(db);
  // Токен вебхука — секрет интеграции: наружу уходит только признак, что он
  // задан, сам токен виден в настройках отдельным запросом администратору.
  // bodyCompat — совместимость кузовов автоподбора: клиент («Потоки»,
  // подсказки назначения) обязан фильтровать теми же правилами, что сервер.
  const { telegram, ...rest } = settings;
  return { ...rest, bodyCompat: BODY_COMPAT,
    telegram: { enabled: Boolean(telegram?.botToken), botName: telegram?.botName || '' },
    telephony: telephony
    ? { enabled: Boolean(telephony.enabled), provider: telephony.provider || '',
      hasToken: Boolean(telephony.token), popup: telephony.popup !== false }
    : { enabled: false, provider: '', hasToken: false, popup: true } };
}

async function readJson(request, limit = 1_000_000) {
  let raw = '';
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > limit) throw Object.assign(new Error('Слишком большой запрос'), { status: 413 });
  }
  if (!raw) return {};
  try { return JSON.parse(raw); }
  catch { throw Object.assign(new Error('Некорректный JSON'), { status: 400 }); }
}

// Вахтовый график из тела запроса: «N дней работы / M отдыха с даты».
// Все три поля вместе либо пусто; кривые значения — 422.
function parseShift(body) {
  const on = body.shiftOn === '' || body.shiftOn == null ? null : Number(body.shiftOn);
  const off = body.shiftOff === '' || body.shiftOff == null ? null : Number(body.shiftOff);
  const anchor = String(body.shiftAnchor || '').slice(0, 10) || null;
  if (on == null && off == null && !anchor) return { on: null, off: null, anchor: null };
  if (!Number.isInteger(on) || !Number.isInteger(off) || on < 1 || off < 1 || on > 90 || off > 90 ||
      !/^\d{4}-\d{2}-\d{2}$/.test(anchor || '')) {
    throw Object.assign(new Error('Вахта: дни работы и отдыха 1–90 и дата начала рабочего периода — или все поля пустые'), { status: 422 });
  }
  return { on, off, anchor };
}

async function readRaw(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error(`Файл больше ${Math.round(limit / 1_048_576)} МБ`), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function publicUser(user) {
  const roles = rolesOf(user);
  return { telegramLinked: Boolean(user.telegram_chat_id), telegramMode: user.telegram_mode || 'critical',
    id: user.id, username: user.username, fullName: user.full_name, email: user.email || '',
    role: user.role, roles, roleLabel: roleLabelsFor(roles), active: Boolean(user.active),
    guest: Boolean(Number(user.guest)),
    permissions: effectivePermissions(user)
  };
}

function currentUser(request) {
  const token = parseCookies(request.headers.cookie).planner_session;
  if (!token) return null;
  return db.prepare(`
    SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=? AND datetime(s.expires_at)>CURRENT_TIMESTAMP AND u.active=1`
  ).get(tokenHash(token)) || null;
}

function requireUser(request, response) {
  const user = currentUser(request);
  if (!user) errorJson(response, 401, 'Требуется вход');
  return user;
}

function requirePermission(request, response, permission) {
  const user = requireUser(request, response);
  if (!user) return null;
  if (!hasPermission(user, permission)) {
    errorJson(response, 403, 'Недостаточно прав');
    return null;
  }
  return user;
}

function mutationOriginAllowed(request) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return true;
  const origin = request.headers.origin;
  if (!origin) return true;
  // X-Forwarded-Proto может прийти списком ("https, https") при дублях у прокси — берём первый элемент.
  const forwarded = trustedForwarding(request)
    ? String(request.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() : '';
  const scheme = ['http', 'https'].includes(forwarded)
    ? forwarded
    : (request.socket.encrypted ? 'https' : 'http');
  const expected = `${scheme}://${request.headers.host}`;
  return origin === expected;
}

function route(pattern, pathname) {
  const match = pathname.match(pattern);
  return match ? match.slice(1).map(decodeURIComponent) : null;
}

// Подсказка геозоны по тексту адреса: сначала субъект РФ (по географии
// зон компании — «Омская обл» надёжнее города, который бывает не в
// справочнике), затем алиас/имя зоны в городской части (до запятой).
// Разбор 01–02.09: адреса с ручной зоной «Дом» ломали геозоны заявок.
const SUBJECT_ZONES = [
  ['Дом', /(пензенск|мордови|саратовск|тамбовск)\w*\s*(обл|край|респ)/i],
  ['Москва', /(московск|тульск|калужск|рязанск)\w*\s*обл/i],
  ['Москва', /\sМО\s*$/],
  ['Питер', /(ленинградск|новгородск|вологодск|тверск)\w*\s*обл/i],
  ['Питер', /санкт-петербург/i],
  ['Золотое кольцо', /(нижегородск|владимирск|ивановск|костромск|ярославск)\w*\s*обл/i],
  ['Самара', /(самарск|ульяновск|оренбургск)\w*\s*обл/i],
  ['Самара', /(татарстан|марий эл|чуваш)/i],
  ['Урал', /(свердловск|челябинск|кировск)\w*\s*обл|пермск\w*\s*край|удмурт|башкорт|башкири/i],
  ['Восток', /(новосибирск|омск|кемеровск|томск|тюменск|иркутск)\w*\s*обл|(алтайск|красноярск)\w*\s*край|ханты|\sНвСиб\s*$/i],
  ['Черноземье', /(воронежск|липецк|курск|белгородск|брянск|орловск)\w*\s*обл/i],
  ['Юг', /(ростовск|волгоградск|астраханск)\w*\s*обл|(краснодарск|ставропольск)\w*\s*край|карачаево/i],
  ['Запад', /(смоленск|псковск)\w*\s*обл/i]
];
// Геокодинг через ОБЩИЙ КЛАССИФИКАТОР OpenStreetMap (Nominatim): адрес →
// координаты + субъект РФ. Одна функция на ручной поиск («🌍 Найти»),
// автозаполнение при создании пункта и ночной сторож недогеокоженных.
// ФИАС/ГАР целиком не тянем (гигабайты выгрузок на LXC за NAT), платные
// подсказчики (DaData) — опция за API-ключ, если понадобится ввод с
// подсказками; для зоны/подгона хватает OSM.
async function geocodeQuery(query) {
  const osm = await fetch('https://nominatim.openstreetmap.org/search?' + new URLSearchParams({
    format: 'jsonv2', addressdetails: '1', countrycodes: 'ru', limit: '5', q: query
  }), {
    headers: { 'User-Agent': 'PegasLogistic/1.0 (dispatch planner; tkpegasnigovorin@gmail.com)' },
    signal: AbortSignal.timeout(7000)
  });
  if (!osm.ok) throw new Error(`Источник геокодинга недоступен (${osm.status})`);
  const rows = await osm.json();
  const normalizeRegion = value => {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (/^москва$/iu.test(raw)) return 'Москва г';
    if (/^санкт-петербург$/iu.test(raw)) return 'Санкт-Петербург г';
    const oblast = raw.match(/^(.+?)\s+область$/iu);
    if (oblast) return `${oblast[1]} обл`;
    const republic = raw.match(/^республика\s+(.+)$/iu);
    if (republic) return `${republic[1]} респ`;
    return raw;
  };
  return rows.map(row => ({
    name: row.display_name,
    latitude: Number(row.lat),
    longitude: Number(row.lon),
    region: normalizeRegion(row.address?.state || row.address?.city || '')
  }));
}

function zoneHintForAddress(text, latitude = null, longitude = null) {
  const full = String(text || '').trim();
  if (!full) return null;
  for (const [zoneName, pattern] of SUBJECT_ZONES) {
    if (pattern.test(full)) {
      const zone = db.prepare('SELECT id, name FROM zones WHERE name=?').get(zoneName);
      if (zone) return { ...zone, via: 'субъект РФ' };
    }
  }
  // Координаты надёжнее имени города: топонимы дублируются по стране
  // (Преображенка есть и в Самарской области, и в алиасах Москвы) —
  // при известных координатах берём ближайший центр зоны.
  if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
    const nearest = db.prepare(`SELECT id, name, latitude, longitude FROM zones
        WHERE latitude IS NOT NULL`).all()
      .map(zone => ({ ...zone, km: roadKm(latitude, longitude, zone.latitude, zone.longitude) }))
      .sort((a, b) => a.km - b.km)[0];
    if (nearest) return { id: nearest.id, name: nearest.name, via: 'координаты' };
  }
  const head = full.split(',')[0].toLowerCase();
  const hit = db.prepare(`SELECT z.id, z.name, z.name AS alias FROM zones z
      UNION ALL SELECT a.zone_id AS id, z2.name, a.alias FROM zone_aliases a
      JOIN zones z2 ON z2.id = a.zone_id`).all()
    .filter(row => {
      const alias = row.alias.toLowerCase();
      if (alias.length >= 5) return head.includes(alias);
      return new RegExp(`(^|[^а-яёa-z])${alias}([^а-яёa-z]|$)`, 'i').test(head);
    })
    .sort((a, b) => b.alias.length - a.alias.length)[0];
  return hit ? { id: hit.id, name: hit.name, via: `город «${hit.alias}»` } : null;
}

function allReferenceData() {
  const zoneRows = db.prepare('SELECT * FROM zones ORDER BY sort_order').all();
  const aliases = db.prepare('SELECT zone_id,alias FROM zone_aliases ORDER BY alias').all();
  return {
    zones: zoneRows.map(zone => ({
      ...zone, aliases: aliases.filter(item => item.zone_id === zone.id).map(item => item.alias)
    })),
    vehicleTypes: db.prepare('SELECT * FROM vehicle_types ORDER BY name').all(),
    addresses: db.prepare(`SELECT a.*,z.name zone_name FROM addresses a
      LEFT JOIN zones z ON z.id=a.zone_id ORDER BY a.name`).all(),
    routeRates: db.prepare(`SELECT r.*, f.name from_name, t.name to_name
      FROM route_rates r JOIN zones f ON f.id=r.from_zone_id JOIN zones t ON t.id=r.to_zone_id
      ORDER BY f.sort_order,t.sort_order`).all()
  };
}

function listVehicles() {
  return db.prepare(`SELECT v.*,vt.name type_name,z.name zone_name,z.color zone_color
    FROM vehicles v JOIN vehicle_types vt ON vt.id=v.type_id
    LEFT JOIN zones z ON z.id=v.zone_id ORDER BY v.plate`).all();
}

function listTrips(search = '') {
  return db.prepare(`SELECT t.*,v.plate vehicle_plate,v.trailer_plate,v.driver_name,vt.name vehicle_type,
    f.name from_name,f.color from_color,d.name to_name,d.color to_color
    FROM trips t JOIN vehicles v ON v.id=t.vehicle_id
    JOIN vehicle_types vt ON vt.id=v.type_id JOIN zones f ON f.id=t.from_zone_id
    JOIN zones d ON d.id=t.to_zone_id
    WHERE (?='' OR t.starts_at<=? AND t.ends_at>=?)
    ORDER BY t.starts_at`).all(search, search, search);
}

// Отклонённые заявки тоже отдаются: доска продаж строит из них реестр «Отклонённые».
function listOrders() {
  return db.prepare(`SELECT o.*,f.name from_name,t.name to_name
    FROM orders o JOIN zones f ON f.id=o.from_zone_id JOIN zones t ON t.id=o.to_zone_id
    ORDER BY o.window_from`).all();
}

function listDispositions() {
  // Перегон везёт с собой пункт назначения: карточка задания и контроль
  // показывают, куда именно гонят машину, а не только «перегон».
  return db.prepare(`SELECT d.*,v.plate vehicle_plate,v.driver_name,
      a.name to_name,a.region to_region
    FROM vehicle_dispositions d JOIN vehicles v ON v.id=d.vehicle_id
    LEFT JOIN addresses a ON a.id=d.address_id ORDER BY d.starts_at,v.plate`).all();
}

function tripOutboxPayload(id) {
  const row = db.prepare(`SELECT t.id,t.external_id externalId,t.external_etag externalEtag,t.customer_name customerName,
    t.starts_at startsAt,t.ends_at endsAt,t.distance_km distanceKm,t.revenue_vat revenueVat,
    t.status,t.rejection_reason rejectionReason,t.temperature_mode temperatureMode,
    t.body_type bodyType,t.actual_distance_km actualDistanceKm,t.unloaded_at unloadedAt,
    v.plate vehiclePlate,v.external_id vehicleKey,
    f.name fromZoneName,f.external_id fromZoneKey,d.name toZoneName,d.external_id toZoneKey
    FROM trips t JOIN vehicles v ON v.id=t.vehicle_id
    JOIN zones f ON f.id=t.from_zone_id JOIN zones d ON d.id=t.to_zone_id WHERE t.id=?`).get(id);
  if (!row) return { id };
  return {
    ...row, vehicle: row.vehicleKey || row.vehiclePlate,
    fromZone: row.fromZoneKey || row.fromZoneName, toZone: row.toZoneKey || row.toZoneName
  };
}

function orderOutboxPayload(id) {
  const row = db.prepare(`SELECT o.id,o.external_id externalId,o.external_etag externalEtag,o.customer_name customerName,
    o.rate_vat rateVat,o.window_from windowFrom,o.window_to windowTo,o.status,
    o.temperature_mode temperatureMode,o.body_type bodyType,o.stage,
    f.name fromZoneName,f.external_id fromZoneKey,t.name toZoneName,t.external_id toZoneKey
    FROM orders o JOIN zones f ON f.id=o.from_zone_id JOIN zones t ON t.id=o.to_zone_id
    WHERE o.id=?`).get(id);
  if (!row) return { id };
  return {
    ...row, fromZone: row.fromZoneKey || row.fromZoneName, toZone: row.toZoneKey || row.toZoneName
  };
}

function integrationPublic() {
  const row = db.prepare('SELECT * FROM integration_config WHERE id=1').get();
  const telematics = db.prepare(`SELECT id,name,base_url,enabled,last_success_at,updated_at
    FROM integration_connectors WHERE id='telematics'`).get();
  return {
    baseUrl: row.base_url, username: row.username, hasPassword: Boolean(row.password_cipher),
    enabled: Boolean(row.enabled), pullIntervalMin: row.pull_interval_min,
    writeEnabled: Boolean(row.write_enabled), writePolicy: row.write_policy,
    verifyTls: Boolean(row.verify_tls), lastSuccessAt: row.last_success_at,
    telematics: {
      ...telematics, baseUrl: telematics?.base_url || '', enabled: Boolean(telematics?.enabled),
      hasToken: Boolean(db.prepare(`SELECT token_cipher FROM integration_connectors
        WHERE id='telematics'`).get()?.token_cipher)
    }
  };
}

// ── Внутренний чат и уведомления конвейера ──
// Авто-сообщение адресуется роли следующего участника процесса: клиент
// показывает его тостом со звуком тем, у кого эта роль, и пишет в общий чат.
// ── Telegram-уведомления в мессенджер на телефон ──
// Бот настраивается админом (Настройки → Telegram): токен от @BotFather.
// Сотрудник привязывает свой чат командой /start КОД. Режимы: critical —
// только аварии (🚨, ⚖ узкие дни, невыход в окно), all — плюс все
// уведомления своей роли и общие рассылки.
const telegramConfig = () => settingsObject(db).telegram || {};
// Категории уведомлений: руководитель настраивает уровень каждой в
// «Настройки → Telegram»: off — в мессенджер не шлём (лента планера
// остаётся), critical — получают все привязанные (и режим «аварии», и
// «все»), normal — только выбравшие режим «все уведомления».
const NOTIFY_CATEGORIES = {
  stuck: { label: '🚨 Простои на точках (не выгружают/не грузят)', def: 'critical' },
  balance: { label: '⚖ Узкие дни баланса парк↔сетка', def: 'critical' },
  missed_departure: { label: '⏰ Невыход машины в окно погрузки', def: 'critical' },
  daily_report: { label: '📆 Утренний отчёт дня (всем)', def: 'normal' },
  gap_review: { label: '📬 Ревизия зазоров 10/14/16', def: 'normal' },
  debt_1c: { label: '📒 Долги перед 1С', def: 'normal' },
  driver_questions: { label: '⏱ Просроченные вопросы водителей', def: 'normal' },
  claims: { label: '📑 Претензии (срывы, простои П/В)', def: 'normal' },
  order_deadlines: { label: '⏳ Дедлайны заявок (подтвердить/назначить)', def: 'normal' },
  shift_handover: { label: '🌙 Ночная передача смены', def: 'normal' },
  stale_transfers: { label: '🚚 Зависшие перегоны', def: 'normal' },
  sales_directions: { label: '🧭 Утренние направления продажам', def: 'normal' },
  no_next: { label: '⏭ Выгрузка близко, следующий рейс не назначен', def: 'normal' },
  resource_watch: { label: '🔧 Сторож ресурса (без водителя/заказа 3+ дн)', def: 'normal' },
  shift_digest: { label: '📋 Сводка смены (18:00 на ночь / 06:00 на день)', def: 'normal' },
  crm: { label: '🎂 CRM-поводы (дни рождения, контакты)', def: 'off' },
  other: { label: 'Прочее (операционный конвейер)', def: 'normal' }
};
const notifyLevelOf = category => {
  const rules = settingsObject(db).notifyRules || {};
  const level = rules[category];
  return ['off', 'critical', 'normal'].includes(level)
    ? level : (NOTIFY_CATEGORIES[category]?.def || 'normal');
};
// Запрос к Bot API через node:https с family:4: у LXC нет IPv6-маршрута,
// а undici-fetch упорно коннектится по v6 (при том что dns.lookup отдаёт
// v4 из /etc/hosts) — таймаут. Прямой https с family:4 стабилен (~200 мс).
function tgApi(method, payload, tokenOverride = null) {
  return new Promise(resolve => {
    const token = tokenOverride || telegramConfig().botToken;
    if (!token) return resolve(null);
    const body = JSON.stringify(payload || {});
    const request = httpsRequest({
      host: 'api.telegram.org', family: 4, method: 'POST',
      path: `/bot${token}/${method}`, timeout: 10_000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, response => {
      let raw = '';
      response.on('data', chunk => { raw += chunk; });
      response.on('end', () => {
        try { resolve(JSON.parse(raw)); } catch { resolve(null); }
      });
    });
    request.on('error', () => resolve(null));
    request.on('timeout', () => { request.destroy(); resolve(null); });
    request.end(body);
  });
}
function sendTelegramTo(chatIds, text) {
  if (!telegramConfig().botToken || !chatIds.length) return;
  const body = String(text).slice(0, 3900);
  for (const chatId of chatIds) {
    tgApi('sendMessage', { chat_id: chatId, text: body });
  }
}
function telegramChatsForRole(targetRole, level) {
  if (!telegramConfig().botToken || level === 'off') return [];
  return db.prepare(`SELECT telegram_chat_id FROM users
      WHERE active=1 AND deleted_at IS NULL AND telegram_chat_id IS NOT NULL
        AND (roles LIKE ? OR role = ?)
        AND (telegram_mode = 'all' OR (telegram_mode = 'critical' AND ?))`)
    .all(`%"${targetRole}"%`, targetRole, level === 'critical' ? 1 : 0)
    .map(row => row.telegram_chat_id);
}

function notify(targetRole, text, entity = null, entityId = null, { category = 'other' } = {}) {
  db.prepare(`INSERT INTO messages(author_name,kind,text,target_role,entity,entity_id)
    VALUES('Конвейер','auto',?,?,?,?)`).run(text, targetRole, entity, entityId);
  try {
    sendTelegramTo(telegramChatsForRole(targetRole, notifyLevelOf(category)), text);
  } catch { /* не критично */ }
}

// Персональная рассылка всем действующим сотрудникам: каждому — своё
// авто-сообщение (recipient_id), видно в его ленте «⚙ Конвейер» с тостом и
// звуком как адресованное. Так уходит утренний отчёт дня.
function notifyEveryone(text, entity = null, entityId = null) {
  const users = db.prepare(`SELECT id FROM users WHERE active=1 AND deleted_at IS NULL`).all();
  const insert = db.prepare(`INSERT INTO messages(author_name,kind,text,recipient_id,entity,entity_id)
    VALUES('Конвейер','auto',?,?,?,?)`);
  for (const user of users) insert.run(text, user.id, entity, entityId);
  // Дубль в Telegram по уровню категории (руководитель управляет в
  // Настройках): off — не шлём, critical — всем привязанным, normal —
  // выбравшим режим «все уведомления».
  try {
    const level = notifyLevelOf(arguments[3]?.category || 'daily_report');
    if (level !== 'off') {
      const chats = db.prepare(`SELECT telegram_chat_id FROM users
        WHERE active=1 AND deleted_at IS NULL AND telegram_chat_id IS NOT NULL
          AND (telegram_mode='all' OR ?)`).all(level === 'critical' ? 1 : 0)
        .map(row => row.telegram_chat_id);
      sendTelegramTo(chats, text);
    }
  } catch { /* не критично */ }
  return users.length;
}

// ── Объявления на табло ──
// Общий экран смотрят издалека и мельком, поэтому показываем только то,
// что действует прямо сейчас: снятое или просроченное объявление клиенту
// не отдаём вовсе — иначе на экране висит вчерашняя планёрка.
function activeBoardNotes() {
  return db.prepare(`SELECT id,text,subtext,kind,starts_at,ends_at,created_by_name,created_at
    FROM board_notes
    WHERE removed_at IS NULL AND datetime(starts_at) <= datetime('now')
      AND (ends_at IS NULL OR datetime(ends_at) > datetime('now'))
    ORDER BY CASE kind WHEN 'urgent' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END, created_at DESC`).all();
}

// Маршрут для текста уведомления: пункты, при их отсутствии — геозоны.
function routeText(row) {
  const zoneName = id => db.prepare('SELECT name FROM zones WHERE id=?').get(id)?.name || '';
  const from = row.from_point || zoneName(row.from_zone_id);
  const to = row.to_point || zoneName(row.to_zone_id);
  return `${from} → ${to}`;
}

// Сторож выгрузки: «ТС не выгружают более 6 часов» — первый алерт продажам
// и логистам, затем ежечасные пинги диспетчерам, пока рейс не выгружен.
function runUnloadWatch() {
  try {
    for (const event of checkStuckUnloading(db)) {
      const hours = Math.floor(event.waitedMs / 3_600_000);
      const label = `ТС ${event.trip.vehicle_plate} (${routeText(event.trip)}, ${event.trip.customer_name || 'без заказчика'})`;
      if (event.kind === 'first') {
        notify('sales', `${label} не выгружают более 6 ч — уведомите клиента; простой можно выставить в «Диспетчере»`, 'trip', event.trip.id, { category: 'stuck' });
        notify('logist', `${label} стоит на выгрузке ${hours} ч — учтите при планировании следующих рейсов сцепки`, 'trip', event.trip.id, { category: 'stuck' });
      } else {
        notify('dispatcher', `Особый контроль: ${label} стоит на выгрузке уже ${hours} ч — проверьте статус и зафиксируйте простой`, 'trip', event.trip.id, { category: 'stuck' });
      }
    }
  } catch (error) {
    console.error('Сторож выгрузки:', error.message);
  }
}
setInterval(runUnloadWatch, 10 * 60_000);
setTimeout(runUnloadWatch, 15_000);

// Сторож-геокодер: адреса справочника без координат по одному подтягиваются
// из общего классификатора (OSM) — щадящий темп (1 адрес / 90 с) в рамках
// правил Nominatim. Координаты дают подгон и плановый километраж; субъект —
// если пуст; зона — только если не была проставлена вовсе. Неудача
// помечается geocode_try_at и повторяется не раньше чем через неделю.
async function runGeocodeWatch() {
  try {
    const address = db.prepare(`SELECT id, name, address, region, zone_id FROM addresses
      WHERE latitude IS NULL
        AND (geocode_try_at IS NULL OR datetime(geocode_try_at) < datetime('now', '-7 days'))
      ORDER BY name LIMIT 1`).get();
    if (!address) return;
    db.prepare(`UPDATE addresses SET geocode_try_at=CURRENT_TIMESTAMP WHERE id=?`).run(address.id);
    // Каскад упрощений: полный адрес часто не находится из-за «д. 8, стр. 4»
    // и сокращений — пробуем без дома, затем первые два сегмента (щадя
    // Nominatim паузой между попытками).
    const raw = String(address.address || '').trim() || String(address.name || '').trim();
    const noHouse = raw.replace(/(?:,\s*)?(?:д\.?|дом|стр\.?|строение|влд\.?|владение|корп\.?|тер\.?)\s*№?\s*[\dА-Яа-я/\-]+\s*/gi, ' ')
      .replace(/\s{2,}/g, ' ').replace(/\s,/g, ',').trim();
    const short = raw.split(',').map(part => part.trim()).filter(Boolean).slice(0, 2).join(', ');
    let hit = null;
    for (const variant of [...new Set([raw, noHouse, short])].filter(Boolean)) {
      [hit] = await geocodeQuery(variant);
      if (hit && Number.isFinite(hit.latitude)) break;
      hit = null;
      await new Promise(resolve => setTimeout(resolve, 1_300));
    }
    if (!hit) return;
    const { BASE_POINT } = await import('./db.mjs');
    const region = String(address.region || '').trim() || hit.region;
    const zoneId = address.zone_id
      || zoneHintForAddress(`${address.name} ${region}`, hit.latitude, hit.longitude)?.id || null;
    db.prepare(`UPDATE addresses SET latitude=?, longitude=?, region=?, zone_id=?,
      base_distance_km=? WHERE id=?`).run(
      hit.latitude, hit.longitude, region, zoneId,
      roadKm(hit.latitude, hit.longitude, BASE_POINT.lat, BASE_POINT.lon), address.id);
    audit(db, null, 'geocode', 'address', address.id,
      { name: address.name, latitude: hit.latitude, longitude: hit.longitude, region }, 'watch');
  } catch { /* классификатор недоступен — попробуем следующим тиком */ }
}
setInterval(runGeocodeWatch, 90_000);
setTimeout(runGeocodeWatch, 70_000);

// Сторож ресурса: сцепка «без водителя» (по интервалу в календаре) или
// «без заказа» три и более дней → авто-сообщение роли «Ресурс»,
// не чаще раза в сутки на сцепку.
function runResourceWatch() {
  try {
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const dayMs = 86_400_000;
    const vehicles = db.prepare(`SELECT id,plate,driver_name,resource_alert_at
      FROM vehicles WHERE status='work'`).all();
    for (const vehicle of vehicles) {
      if (vehicle.resource_alert_at && nowMs - Date.parse(vehicle.resource_alert_at) < dayMs) continue;
      // «Без водителя»: активный интервал no_driver, начавшийся 3+ дня назад.
      const noDriver = db.prepare(`SELECT starts_at FROM vehicle_dispositions
        WHERE vehicle_id=? AND kind='no_driver' AND starts_at<=? AND ends_at>?
        ORDER BY starts_at LIMIT 1`).get(vehicle.id, nowIso, nowIso);
      const noDriverDays = noDriver ? Math.floor((nowMs - Date.parse(noDriver.starts_at)) / dayMs) : 0;
      // «Без заказа»: последний рейс завершился 3+ дня назад, новых нет,
      // и простой ничем не объяснён (нет активной диспозиции).
      const lastTrip = db.prepare(`SELECT MAX(ends_at) e FROM trips
        WHERE vehicle_id=? AND status<>'rejected'`).get(vehicle.id);
      const idleDays = lastTrip?.e && lastTrip.e < nowIso
        ? Math.floor((nowMs - Date.parse(lastTrip.e)) / dayMs) : 0;
      const covered = db.prepare(`SELECT 1 FROM vehicle_dispositions
        WHERE vehicle_id=? AND starts_at<=? AND ends_at>? LIMIT 1`).get(vehicle.id, nowIso, nowIso);
      let text = null;
      if (noDriverDays >= 3) {
        text = `Сцепка ${vehicle.plate} без водителя уже ${noDriverDays} дн — закрепите водителя (справочник «Водители») или оформите вывод`;
      } else if (idleDays >= 3 && !covered) {
        text = `Сцепка ${vehicle.plate} без заказа ${idleDays} дн — запросите загрузку у продаж или оформите причину простоя`;
      }
      if (text) {
        notify('resource', text, 'vehicle', vehicle.id, { category: 'resource_watch' });
        db.prepare(`UPDATE vehicles SET resource_alert_at=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
          .run(nowIso, vehicle.id);
      }
    }
  } catch (error) {
    console.error('Сторож ресурса:', error.message);
  }
}
setInterval(runResourceWatch, 60 * 60_000);
setTimeout(runResourceWatch, 25_000);

// ── Ежедневный отчёт по автопарку: каждое утро после 07:00 МСК сводка
// за вчера уходит в чат руководителю (роль manager; чат видят все).
// Флаг в app_meta защищает от дублей при перезапусках контейнера.
function runDailyFleetReport() {
  try {
    const mskNow = new Date(Date.now() + 3 * 3_600_000);
    if (mskNow.getUTCHours() < 7) return;
    const todayIso = mskNow.toISOString().slice(0, 10);
    const sent = db.prepare(`SELECT value FROM app_meta WHERE key='daily_fleet_report_day'`).get();
    if (sent?.value === todayIso) return;
    const dayIso = new Date(Date.parse(`${todayIso}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    const snap = reportSnapshot(db, dayIso, todayIso);
    const dayStart = Date.parse(`${dayIso}T00:00:00Z`);
    const dayEnd = dayStart + 86_400_000;
    const fleet = db.prepare(`SELECT id,plate FROM vehicles WHERE status='work'`).all();
    // В рейсе — по факту (вывод на линию → фактическая выгрузка), как в
    // отчётах и на дашборде; плановые даты занижали число машин на линии.
    const dayTrips = db.prepare(`SELECT vehicle_id,status,starts_at,ends_at,on_line_at,unloaded_at FROM trips
      WHERE status<>'rejected' AND starts_at<datetime(?,'+3 days') AND ends_at>datetime(?,'-3 days')`)
      .all(new Date(dayEnd).toISOString(), new Date(dayStart).toISOString())
      .filter(trip => { const r = tripBusyRange(trip); return r.from < dayEnd && r.to > dayStart; });
    const inTrip = new Set(dayTrips.map(row => row.vehicle_id));
    const dispositions = db.prepare(`SELECT vehicle_id,kind,starts_at,ends_at FROM vehicle_dispositions
      WHERE starts_at<? AND ends_at>?`)
      .all(new Date(dayEnd).toISOString(), new Date(dayStart).toISOString());
    const counts = { repair: 0, shift: 0, no_driver: 0, reserve: 0 };
    const idlePlates = [];
    for (const vehicle of fleet) {
      if (inTrip.has(vehicle.id)) continue;
      const covering = dispositions.filter(item => item.vehicle_id === vehicle.id)
        .sort((a, b) =>
          (Math.min(Date.parse(b.ends_at), dayEnd) - Math.max(Date.parse(b.starts_at), dayStart)) -
          (Math.min(Date.parse(a.ends_at), dayEnd) - Math.max(Date.parse(a.starts_at), dayStart)))[0];
      if (covering && counts[covering.kind] != null) counts[covering.kind] += 1;
      else if (covering) counts.reserve += 1;
      else idlePlates.push(vehicle.plate);
    }
    const rubShort = value => `${Math.round(Number(value || 0)).toLocaleString('ru-RU')} ₽`;
    const pctShort = value => `${Math.round((value || 0) * 100)}%`;
    const u = snap.utilization || {};
    const dayLabel = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' })
      .format(new Date(`${dayIso}T12:00:00Z`));
    // Смена продаж и план дня: внесено/назначено, средний чек, выполнение
    // дневного плана (остаток месячного 160 млн на остаток дней).
    const created = db.prepare(`SELECT COUNT(*) c, COALESCE(SUM(rate_vat),0) s FROM orders
      WHERE status<>'cancelled' AND created_at>=? AND created_at<?`)
      .get(`${dayIso} 00:00:00`, `${todayIso} 00:00:00`);
    const assignedCount = db.prepare(`SELECT COUNT(*) c FROM trips
      WHERE status<>'rejected' AND order_id IS NOT NULL AND source_system<>'1c'
        AND created_at>=? AND created_at<?`)
      .get(`${dayIso} 00:00:00`, `${todayIso} 00:00:00`).c;
    const monthKey = `${dayIso.slice(0, 7)}-01`;
    const monthPlan = Number(db.prepare(`SELECT target_net FROM revenue_plans WHERE period_start=?`)
      .get(monthKey)?.target_net || 0) || 160_000_000;
    const factBefore = reportSnapshot(db, monthKey, dayIso).netRevenue || 0;
    const dayDate = new Date(`${dayIso}T00:00:00Z`);
    const daysInMonth = new Date(Date.UTC(dayDate.getUTCFullYear(), dayDate.getUTCMonth() + 1, 0)).getUTCDate();
    const remainingFromDay = daysInMonth - dayDate.getUTCDate() + 1;
    const dayPlan = Math.max(0, (monthPlan - factBefore) / Math.max(1, remainingFromDay));
    const tripsDone = db.prepare(`SELECT COUNT(*) c FROM trips
      WHERE status<>'rejected' AND ends_at>=? AND ends_at<?`)
      .get(`${dayIso}T00:00:00.000Z`, `${todayIso}T00:00:00.000Z`).c;
    const avgCheck = tripsDone ? (snap.netRevenue || 0) / tripsDone : 0;
    notifyEveryone(`📆 Отчёт дня за ${dayLabel}: парк ${fleet.length} · в рейсе ${inTrip.size}` +
      ` (${pctShort(inTrip.size / (fleet.length || 1))}) · простой без причины ${idlePlates.length}` +
      `${idlePlates.length ? ` (${idlePlates.slice(0, 6).join(', ')}${idlePlates.length > 6 ? '…' : ''})` : ''}` +
      ` · ремонт ${counts.repair}, пересм. ${counts.shift}, без вод. ${counts.no_driver}, резерв ${counts.reserve}` +
      ` · выручка бНДС ${rubShort(snap.netRevenue)} · пробег ${Math.round(snap.loadedKm || 0)} км` +
      ` + ${Math.round(snap.emptyKm || 0)} порожних (${pctShort(snap.emptyRatio)})` +
      ` · КТГ ${pctShort(u.ktg)} · КВЛ ${pctShort(u.kvl)} · КИП ${pctShort(u.kip)}` +
      ` · план дня ${rubShort(dayPlan)} — выполнение ${Math.round((snap.netRevenue || 0) / (dayPlan || 1) * 100)}%` +
      ` · ср. чек ${rubShort(avgCheck)} · смена: внесено ${created.c} заявок на ${rubShort(created.s)}, назначено ${assignedCount}` +
      (() => {
        // Явка водителей за вчера: вышло/невыход по причинам/не отмечено.
        const att = attendanceSummary(db, dayIso);
        const reasons = Object.entries(att.byReason)
          .map(([key, count]) => `${ABSENCE_REASONS[key] || key} ${count}`).join(', ');
        return att.present + att.absent
          ? ` · явка: вышло ${att.present}, невыход ${att.absent}${reasons ? ` (${reasons})` : ''}` +
            `${att.unmarked ? `, не отмечено ${att.unmarked}` : ''}` +
            ` · укомплектованность ${att.staffing.toFixed(2)}/${att.staffingTarget}`
          : ' · явка за день не велась';
      })() +
      ` — детали в «Руководитель → 📆 Отчёт дня» и на «Дашборде»`);
    db.prepare(`INSERT INTO app_meta(key,value) VALUES('daily_fleet_report_day',?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(todayIso);
  } catch (error) {
    console.error('Ежедневный отчёт парка:', error.message);
  }
}
setInterval(runDailyFleetReport, 5 * 60_000);
setTimeout(runDailyFleetReport, 40_000);

// ── Ежедневное формирование документов по простою ──
// Раз в день после 07:00 МСК: каждый случай простоя сверх бесплатного
// норматива (8 ч от планового времени операции по заявке) фиксируется
// в истории претензий demurrage_claims — документ на счёт клиенту готов
// к печати из плашки «⏳ Простои П/В». Незавершённые случаи (машина ещё
// стоит) обновляются ежедневно, пока статус «к выставлению»; претензии,
// уже выставленные или отменённые вручную, не трогаются.
// Срыв заявки клиентом: рейс снят с причиной «Отказ клиента» или «Нет груза» —
// машина уже была назначена (а часто и подана), поэтому случай сразу падает
// в реестр «⏳ Простои П/В» претензией к выставлению. Часы — от планового
// времени погрузки до момента отказа, каждый начатый час по тарифу простоя,
// минимум 1 час (отказ до подачи — минимальная претензия, решение о
// выставлении или отмене за продажами). Бесплатный норматив не применяется:
// погрузка не состоялась вовсе. Если по рейсу уже есть претензия за реальный
// простой под погрузкой — она сохраняется (ON CONFLICT DO NOTHING).
const FALSE_CALL_REASONS = ['Отказ клиента', 'Нет груза'];
function falseCallClaim(trip, reason) {
  const { rate } = demurrageSettings(db);
  const planMs = Date.parse(trip.starts_at);
  const nowMs = Date.now();
  const idleHours = Math.max(0, (nowMs - planMs) / 3_600_000);
  // Потолок — сутки: старый план, снятый через неделю, не должен рождать
  // претензию на сотни часов; спорную сумму продажи правят при выставлении.
  const paidHours = Math.min(24, Math.max(1, Math.ceil(idleHours)));
  const amount = paidHours * rate;
  const vehicle = db.prepare('SELECT plate, driver_name FROM vehicles WHERE id=?').get(trip.vehicle_id);
  const order = trip.order_id
    ? db.prepare('SELECT order_no, from_point, window_from FROM orders WHERE id=?').get(trip.order_id)
    : null;
  const inserted = db.prepare(`INSERT INTO demurrage_claims(id,trip_id,stop_kind,customer_name,
      order_no,vehicle_plate,driver_name,point,plan_at,arrived_at,finished_at,
      idle_hours,paid_hours,rate,amount,created_day,reason)
    VALUES(?,?,'load',?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(trip_id,stop_kind) DO NOTHING`).run(
    randomUUID(), trip.id, trip.customer_name || '',
    order?.order_no || trip.order_no || '',
    vehicle?.plate || '', vehicle?.driver_name || '',
    order?.from_point || trip.from_point || '',
    order?.window_from || trip.starts_at, order?.window_from || trip.starts_at,
    new Date(nowMs).toISOString(),
    Math.round(idleHours * 10) / 10, paidHours, rate, amount,
    new Date(nowMs + 3 * 3_600_000).toISOString().slice(0, 10), reason);
  if (inserted.changes) {
    const rub = `${Math.round(amount).toLocaleString('ru-RU')} ₽`;
    notify('sales', `📑 Срыв заявки (${reason}): претензия клиенту «${trip.customer_name || '—'}»` +
      ` на ${rub} (${paidHours} ч × тариф простоя) — реестр «⏳ Простои П/В», проверьте и выставьте`, null, null, { category: 'claims' });
  }
}

function runDailyDemurrage() {
  try {
    const mskNow = new Date(Date.now() + 3 * 3_600_000);
    if (mskNow.getUTCHours() < 7) return;
    const todayIso = mskNow.toISOString().slice(0, 10);
    const done = db.prepare(`SELECT value FROM app_meta WHERE key='demurrage_claims_day'`).get();
    if (done?.value === todayIso) return;
    const cases = demurrageCases(db);
    const existing = new Set(db.prepare(`SELECT trip_id||char(124)||stop_kind k FROM demurrage_claims`)
      .all().map(row => row.k));
    const upsert = db.prepare(`INSERT INTO demurrage_claims(id,trip_id,stop_kind,customer_name,
        order_no,vehicle_plate,driver_name,point,plan_at,arrived_at,finished_at,
        idle_hours,paid_hours,rate,amount,created_day)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(trip_id,stop_kind) DO UPDATE SET
        finished_at=excluded.finished_at, idle_hours=excluded.idle_hours,
        paid_hours=excluded.paid_hours, rate=excluded.rate, amount=excluded.amount,
        updated_at=CURRENT_TIMESTAMP
      WHERE demurrage_claims.status='new'`);
    let created = 0;
    let createdSum = 0;
    for (const item of cases) {
      upsert.run(randomUUID(), item.tripId, item.kind, item.customer, item.orderNo,
        item.vehiclePlate, item.driverName, item.point, item.planAt, item.arrivedAt,
        item.finishedAt, item.idleHours, item.paidHours, item.rate, item.amount, todayIso);
      if (!existing.has(`${item.tripId}|${item.kind}`)) { created += 1; createdSum += item.amount; }
    }
    if (created) {
      const rub = value => `${Math.round(value).toLocaleString('ru-RU')} ₽`;
      notify('sales', `📑 Простой под погрузкой/выгрузкой: сформировано ${created} претензий` +
        ` на ${rub(createdSum)} (сверх норматива от планового времени по заявке)` +
        ` — плашка «⏳ Простои П/В», документ на печать в карточке случая`, null, null, { category: 'claims' });
    }
    db.prepare(`INSERT INTO app_meta(key,value) VALUES('demurrage_claims_day',?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(todayIso);
  } catch (error) {
    console.error('Ежедневные претензии по простою:', error.message);
  }
}
setInterval(runDailyDemurrage, 10 * 60_000);
setTimeout(runDailyDemurrage, 50_000);

// ── Сторож неподтверждённых заявок ──
// Заказ клиента попадает в карточку клиента сразу после внесения и ждёт
// подтверждения продажами. За 8 часов до планового времени погрузки —
// сигнал продажам (чат «Конвейер», тост, звук), затем каждые 30 минут,
// пока заявка не подтверждена (или не отклонена). Истёкшие больше суток
// назад не дёргаются — они в плашке «Окно истекло».
const CONFIRM_ALERT_BEFORE_MS = 8 * 3_600_000;
const CONFIRM_ALERT_REPEAT_MS = 30 * 60_000;
function runUnconfirmedOrdersWatch() {
  try {
    const nowMs = Date.now();
    const rows = db.prepare(`SELECT o.*, f.name from_name, t.name to_name FROM orders o
      LEFT JOIN zones f ON f.id=o.from_zone_id LEFT JOIN zones t ON t.id=o.to_zone_id
      WHERE o.status='new' AND o.stage=0 AND o.trip_id IS NULL AND o.deleted_at IS NULL
        AND o.window_from <= ? AND o.window_to > ?
        AND (o.confirm_alert_at IS NULL OR o.confirm_alert_at <= ?)`)
      .all(new Date(nowMs + CONFIRM_ALERT_BEFORE_MS).toISOString(),
        new Date(nowMs - 86_400_000).toISOString(),
        new Date(nowMs - CONFIRM_ALERT_REPEAT_MS).toISOString());
    const stamp = db.prepare('UPDATE orders SET confirm_alert_at=? WHERE id=?');
    for (const order of rows) {
      const leftMs = Date.parse(order.window_from) - nowMs;
      const hours = Math.floor(Math.abs(leftMs) / 3_600_000);
      const minutes = Math.round((Math.abs(leftMs) % 3_600_000) / 60_000);
      const when = leftMs > 0
        ? `погрузка через ${hours} ч ${minutes} мин`
        : `время погрузки прошло ${hours} ч ${minutes} мин назад`;
      notify('sales', `⏳ Заявка ${order.order_no ? `№ ${order.order_no} ` : ''}${order.customer_name}: ` +
        `${routeText(order)} не подтверждена — ${when}. Подтвердите или отклоните ` +
        `(«Продажи → Клиенты»); сигнал повторится через 30 минут`, 'order', order.id, { category: 'order_deadlines' });
      stamp.run(new Date(nowMs).toISOString(), order.id);
    }
  } catch (error) {
    console.error('Сторож неподтверждённых заявок:', error.message);
  }
}
setInterval(runUnconfirmedOrdersWatch, 5 * 60_000);
setTimeout(runUnconfirmedOrdersWatch, 45_000);

// ── Сторож SLA назначения ТС: норматив — машина назначена за 6 часов до
// погрузки. Подтверждённая заявка без ТС ближе норматива — сигнал логистам
// в чат, повтор каждый час до назначения (данные 14 дней: 79 заявок
// назначались уже после начала окна погрузки — очередь разбиралась
// без оглядки на дедлайны). ──
// Норматив назначения: раньше сигнал приходил за 6 часов до погрузки, и
// это было поздно — медианный подгон 3 ч, но у каждой четвёртой машины
// 8,4 ч, плюс два часа на подготовку выхода. Сигналим за 12 часов, чтобы
// решение можно было принять, пока оно ещё что-то меняет.
const ASSIGN_SLA_MS = 12 * 3_600_000;
const ASSIGN_ALERT_REPEAT_MS = 60 * 60_000;
function runAssignWatch() {
  try {
    const nowMs = Date.now();
    const rows = db.prepare(`SELECT o.*, f.name from_name, t.name to_name FROM orders o
      LEFT JOIN zones f ON f.id=o.from_zone_id LEFT JOIN zones t ON t.id=o.to_zone_id
      WHERE o.status='new' AND o.stage=1 AND o.trip_id IS NULL AND o.deleted_at IS NULL
        AND o.window_from <= ? AND o.window_to > ?
        AND (o.assign_alert_at IS NULL OR o.assign_alert_at <= ?)`)
      .all(new Date(nowMs + ASSIGN_SLA_MS).toISOString(),
        new Date(nowMs).toISOString(),
        new Date(nowMs - ASSIGN_ALERT_REPEAT_MS).toISOString());
    const stamp = db.prepare('UPDATE orders SET assign_alert_at=? WHERE id=?');
    for (const order of rows) {
      const leftMs = Date.parse(order.window_from) - nowMs;
      const hours = Math.floor(Math.abs(leftMs) / 3_600_000);
      const minutes = Math.round((Math.abs(leftMs) % 3_600_000) / 60_000);
      const when = leftMs > 0
        ? `погрузка через ${hours} ч ${minutes} мин`
        : `погрузка началась ${hours} ч ${minutes} мин назад`;
      notify('logist', `⏰ Заявка ${order.order_no ? `№ ${order.order_no} ` : ''}${order.customer_name}: ` +
        `${routeText(order)} без ТС — ${when}. Дедлайн назначения виден в очереди: ` +
        `окно минус подгон машины минус подготовка выхода. ` +
        `Сигнал повторится через час`, 'order', order.id, { category: 'order_deadlines' });
      stamp.run(new Date(nowMs).toISOString(), order.id);
    }
  } catch (error) {
    console.error('Сторож назначения ТС:', error.message);
  }
}
// ── Сторож долгов перед 1С: отложенное внесение заказа и обновление после
// замены ТС не должны забываться — напоминание диспетчерам каждые 3 часа,
// пока долг не закрыт (внесение — шагом «Заказ внесён», обновление —
// кнопкой «✓ 1С обновлено»). ──
const DEBT_1C_REPEAT_MS = 3 * 3_600_000;
function runDebt1cWatch() {
  try {
    const nowIso = new Date().toISOString();
    const rows = db.prepare(`SELECT t.*, v.plate FROM trips t
      JOIN vehicles v ON v.id=t.vehicle_id
      WHERE t.status NOT IN ('rejected','paid')
        AND ((t.deferred_1c_at IS NOT NULL AND t.entered_1c_at IS NULL)
          OR t.needs_1c_update_at IS NOT NULL)
        AND (t.debt_1c_alert_at IS NULL OR t.debt_1c_alert_at <= ?)`)
      .all(new Date(Date.now() - DEBT_1C_REPEAT_MS).toISOString());
    const stamp = db.prepare('UPDATE trips SET debt_1c_alert_at=? WHERE id=?');
    for (const trip of rows) {
      const debts = [];
      if (trip.deferred_1c_at && !trip.entered_1c_at) debts.push('заказ не внесён');
      if (trip.needs_1c_update_at) debts.push(trip.needs_1c_note || 'обновить данные');
      notify('dispatcher', `📒 Долг перед 1С по рейсу ${routeText(trip)} (${trip.plate}): ` +
        `${debts.join('; ')}. Закройте в карточке рейса — напоминание повторится через 3 часа`,
      'trip', trip.id, { category: 'debt_1c' });
      stamp.run(nowIso, trip.id);
    }
  } catch (error) {
    console.error('Сторож долгов 1С:', error.message);
  }
}
setInterval(runDebt1cWatch, 10 * 60_000);
setTimeout(runDebt1cWatch, 65_000);

setInterval(runAssignWatch, 5 * 60_000);
setTimeout(runAssignWatch, 55_000);

// ── Вечерняя передача смены по заявкам ──
// «ДД.ММ ЧЧ:ММ» из ISO-строки как она лежит в данных (без смены пояса).
const ddmm = iso => { const str = String(iso || ''); return str.length >= 16
  ? `${str.slice(8, 10)}.${str.slice(5, 7)} ${str.slice(11, 16)}` : '—'; };
// То же со сдвигом UTC→МСК — для сообщений людям (бот, уведомления).
const mskStamp = value => {
  const ms = typeof value === 'number' ? value : Date.parse(value || '');
  return Number.isFinite(ms) ? ddmm(new Date(ms + 3 * 3_600_000).toISOString()) : '—';
};

// ── Сводка смены: в 18:00 МСК «на ночь» (погрузки 18:00→06:00), в 06:00
// «на день» (06:00→18:00) — всем сотрудникам в ленту и Telegram: погрузки
// по клиентам, заявки без ТС, незакрытые рейсы, текущие опоздания.
// Окно отправки широкое (5 часов): при перезапуске сервера или простое
// сводка всё равно уйдёт, пусть и позже — смене она полезна всю смену.
function buildShiftDigest(kind, nowMs) {
  const mskMidnight = Math.floor((nowMs + 3 * 3_600_000) / 86_400_000) * 86_400_000 - 3 * 3_600_000;
  const [fromMs, toMs] = kind === 'night'
    ? [mskMidnight + 18 * 3_600_000, mskMidnight + 30 * 3_600_000]
    : [mskMidnight + 6 * 3_600_000, mskMidnight + 18 * 3_600_000];
  const from = new Date(fromMs).toISOString(), to = new Date(toMs).toISOString();
  const hhmm = iso => mskStamp(iso).slice(6);
  const lines = [kind === 'night'
    ? `🌙 Сводка на ночь (18:00–06:00 МСК)` : `☀️ Сводка на день (06:00–18:00 МСК)`];
  const loads = db.prepare(`SELECT s.planned_arrival, s.actual_arrival, v.plate, o.customer_name, o.order_no
    FROM trip_stops s JOIN trips t ON t.id=s.trip_id
    LEFT JOIN vehicles v ON v.id=t.vehicle_id LEFT JOIN orders o ON o.trip_id=t.id
    WHERE s.kind='P' AND t.status IN ('plan','run') AND s.planned_arrival>=? AND s.planned_arrival<?
    ORDER BY s.planned_arrival`).all(from, to);
  const started = loads.filter(l => l.actual_arrival).length;
  lines.push(`\n📦 Погрузок: ${loads.length}${started ? ` (на погрузке уже ${started})` : ''}`);
  const byCustomer = new Map();
  for (const l of loads) byCustomer.set(l.customer_name || '—', (byCustomer.get(l.customer_name || '—') || 0) + 1);
  for (const [name, n] of [...byCustomer.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${name.slice(0, 34)} — ${n}`);
  }
  if (loads.length <= 22) for (const l of loads) {
    lines.push(`  ${hhmm(l.planned_arrival)} №${l.order_no || '—'} ${(l.customer_name || '').slice(0, 22)} · ${l.plate || '—'}${l.actual_arrival ? ' ✅' : ''}`);
  }
  const noveh = db.prepare(`SELECT customer_name, order_no, window_from FROM orders
    WHERE status='new' AND stage>=1 AND trip_id IS NULL AND deleted_at IS NULL
      AND window_from>=? AND window_from<? ORDER BY window_from`).all(from, to);
  lines.push(noveh.length
    ? `\n⚠ БЕЗ ТС: ${noveh.length} — ` + noveh.slice(0, 8).map(o =>
      `№${o.order_no || '—'} ${(o.customer_name || '').slice(0, 20)} (${hhmm(o.window_from)})`).join('; ')
    : '\n✅ Все погрузки окна обеспечены ТС');
  const stale = db.prepare(`SELECT t.ends_at, v.plate, o.customer_name, o.order_no,
    (SELECT COUNT(*) FROM trip_stops s WHERE s.trip_id=t.id AND s.actual_departure IS NULL) open_stops
    FROM trips t LEFT JOIN vehicles v ON v.id=t.vehicle_id LEFT JOIN orders o ON o.trip_id=t.id
    WHERE t.status='run' AND t.ends_at < datetime('now','-2 hours') ORDER BY t.ends_at LIMIT 200`).all()
    .filter(t => t.open_stops > 0);
  if (stale.length) lines.push(`\n⏳ Незакрытые рейсы (план окончания прошёл): ${stale.length} — ` +
    stale.slice(0, 5).map(t => `${t.plate || '—'} ${(t.customer_name || '').slice(0, 16)} №${t.order_no || '—'} (${ddmm(String(t.ends_at))})`).join('; '));
  const late = db.prepare(`SELECT s.point, s.kind, s.planned_arrival, s.driver_eta, v.plate, o.customer_name
    FROM trip_stops s JOIN trips t ON t.id=s.trip_id
    LEFT JOIN vehicles v ON v.id=t.vehicle_id LEFT JOIN orders o ON o.trip_id=t.id
    WHERE t.status='run' AND s.actual_arrival IS NULL AND s.planned_arrival < datetime('now','-1 hour')
      AND NOT EXISTS (SELECT 1 FROM trip_stops p WHERE p.trip_id=t.id AND p.seq<s.seq AND p.actual_departure IS NULL)
    ORDER BY s.planned_arrival LIMIT 8`).all();
  if (late.length) lines.push(`\n🚨 Опоздания сейчас: ` + late.map(l =>
    `${l.plate || '—'} ${(l.customer_name || '').slice(0, 16)} (${l.kind === 'P' ? 'погрузка' : 'выгрузка'} ${(l.point || '').slice(0, 24)}, +${Math.round((nowMs - Date.parse(l.planned_arrival)) / 3_600_000)} ч${l.driver_eta ? `, 📱 к ${mskStamp(l.driver_eta)}` : ''})`).join('; '));
  return lines.join('\n');
}

function runShiftDigestWatch() {
  try {
    const nowMs = Date.now();
    const mskHour = new Date(nowMs + 3 * 3_600_000).getUTCHours();
    const kind = mskHour >= 18 && mskHour < 23 ? 'night' : mskHour >= 6 && mskHour < 11 ? 'day' : null;
    if (!kind) return;
    if (notifyLevelOf('shift_digest') === 'off') return;
    const day = new Date(nowMs + 3 * 3_600_000).toISOString().slice(0, 10);
    const key = `${day}:${kind}`;
    if (db.prepare(`SELECT value FROM app_meta WHERE key='shift_digest_last'`).get()?.value === key) return;
    db.prepare(`INSERT INTO app_meta(key,value) VALUES('shift_digest_last',?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key);
    notifyEveryone(buildShiftDigest(kind, nowMs), null, null, { category: 'shift_digest' });
  } catch (error) { console.error('runShiftDigestWatch:', error.message); }
}
// ── Сторож дат: заявка с погрузкой глубоко в прошлом, а движения нет —
// похоже на ошибку даты/месяца при внесении. Сигналим продажам и логисту
// один раз на заявку (память в app_meta), пока не исправят или не отклонят.
function runPastLoadWatch() {
  try {
    const seenRaw = db.prepare(`SELECT value FROM app_meta WHERE key='past_load_ids'`).get()?.value;
    const seen = new Set(seenRaw ? JSON.parse(seenRaw) : []);
    const rows = db.prepare(`SELECT o.id, o.order_no, o.customer_name, o.window_from, o.trip_id
      FROM orders o WHERE o.deleted_at IS NULL AND o.status NOT IN ('cancelled')
        AND o.stage < 4 AND o.window_from < datetime('now', '-24 hours')`).all()
      .filter(row => !seen.has(row.id))
      .filter(row => {
        if (!row.trip_id) return true;
        const trip = db.prepare('SELECT * FROM trips WHERE id=?').get(row.trip_id);
        return trip && ['plan', 'run'].includes(trip.status) && !tripHasMovementFacts(db, trip);
      });
    if (!rows.length) return;
    for (const row of rows) seen.add(row.id);
    db.prepare(`INSERT INTO app_meta(key,value) VALUES('past_load_ids',?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
      .run(JSON.stringify([...seen].slice(-400)));
    const text = `⏰ Погрузка в прошлом, движения нет — проверьте дату и МЕСЯЦ: ` +
      rows.slice(0, 6).map(row => `№${row.order_no || '—'} ${(row.customer_name || '').slice(0, 22)} (погрузка ${mskStamp(row.window_from)})`).join('; ') +
      (rows.length > 6 ? ` и ещё ${rows.length - 6}` : '') + `. Исправьте окно заявки или отклоните её`;
    notify('sales', text, null, null, { category: 'order_deadlines' });
    notify('logist', text, null, null, { category: 'order_deadlines' });
  } catch (error) { console.error('runPastLoadWatch:', error.message); }
}
setInterval(runPastLoadWatch, 3 * 3_600_000);
setTimeout(runPastLoadWatch, 150_000);

setInterval(runShiftDigestWatch, 10 * 60_000);
setTimeout(runShiftDigestWatch, 90_000);

// Разбор августа: заявки, подтверждённые после 16:00 МСК, ждали назначения
// 19–22 часа — до утра. Логист уходит, заявка ложится «в стол», а окно
// погрузки часто уже завтра. В 17:30 МСК собираем такие заявки в одно
// сообщение: либо назначить сейчас, либо осознанно передать ночной смене.
function runEveningHandoff() {
  try {
    const nowMs = Date.now();
    const msk = new Date(nowMs + 3 * 3_600_000);
    const day = msk.toISOString().slice(0, 10);
    const hour = msk.getUTCHours();
    const minutes = msk.getUTCMinutes();
    // Окно 17:30–21:59 МСК, а не одна минута: перезапуск сервера в 18:05
    // иначе съедал сводку за целый день.
    if (hour < 17 || hour >= 22 || (hour === 17 && minutes < 30)) return;
    // Отметка дня — в базе, а не в памяти процесса: после перезапуска
    // сводка не уйдёт второй раз.
    const sent = db.prepare(`SELECT value FROM app_meta WHERE key='evening_handoff_day'`).get()?.value;
    if (sent === day) return;
    const rows = db.prepare(`SELECT o.*, f.name from_name, t.name to_name FROM orders o
      LEFT JOIN zones f ON f.id=o.from_zone_id LEFT JOIN zones t ON t.id=o.to_zone_id
      WHERE o.status='new' AND o.stage=1 AND o.trip_id IS NULL AND o.deleted_at IS NULL
        AND o.window_from <= ?`).all(new Date(nowMs + 36 * 3_600_000).toISOString());
    db.prepare(`INSERT INTO app_meta(key,value) VALUES('evening_handoff_day',?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(day);
    if (!rows.length) return;
    const sum = rows.reduce((acc, order) => acc + Number(order.rate_vat || 0), 0);
    const list = rows.slice(0, 8).map(order => `${order.order_no ? `№${order.order_no} ` : ''}` +
      `${order.customer_name} (погрузка ${ddmm(order.window_from)})`).join('; ');
    notify('logist', `🌙 Передача смены: ${rows.length} заявок без ТС с погрузкой в ближайшие ` +
      `36 часов на ${Math.round(sum / 1000)} тыс ₽. ${list}. ` +
      `Назначьте сегодня — утром до части из них будет поздно`, 'order', rows[0].id, { category: 'shift_handover' });
    notify('dispatcher', `🌙 На ночь остаётся ${rows.length} заявок без ТС с погрузкой ` +
      `в ближайшие 36 часов — если логист не назначил, эскалируйте руководителю`, 'order', rows[0].id, { category: 'shift_handover' });
  } catch (error) {
    console.error('Вечерняя передача смены:', error.message);
  }
}
setInterval(runEveningHandoff, 5 * 60_000);

// ── Норматив ответа на вопрос водителя: 10 минут ──
// Вопрос висит дольше — сигнал всей смене: водитель стоит на погрузке и
// ждёт. Руководитель видит просрочки в отчёте за смену.
function runQuestionSlaWatch() {
  try {
    for (const item of checkQuestionSla(db)) {
      const topic = QUESTION_TOPICS.find(entry => entry.key === item.topic);
      notify('dispatcher', `⏱ Вопрос водителя без ответа больше 10 минут: ` +
        `${topic?.label || item.topic}${item.vehicle_plate ? ` · ${item.vehicle_plate}` : ''}` +
        `${item.driver_name ? ` · ${item.driver_name}` : ''}. Возьмите в работу — водитель ждёт`,
      'question', item.id, { category: 'driver_questions' });
      if (topic?.owner === 'Логист') notify('logist', `⏱ Вопрос водителя ждёт больше 10 минут: ${topic.label}`, 'question', item.id, { category: 'driver_questions' });
      if (topic?.owner === 'Продажи') notify('sales', `⏱ Вопрос водителя ждёт больше 10 минут: ${topic.label}`, 'question', item.id, { category: 'driver_questions' });
      if (topic?.owner === 'Ресурс') notify('resource', `⏱ Вопрос водителя ждёт больше 10 минут: ${topic.label}`, 'question', item.id, { category: 'driver_questions' });
      notify('manager', `⏱ Просрочен вопрос водителя (>10 мин): ${topic?.label || item.topic}` +
        `${item.vehicle_plate ? ` · ${item.vehicle_plate}` : ''}`, 'question', item.id, { category: 'driver_questions' });
    }
  } catch (error) {
    console.error('Сторож вопросов водителей:', error.message);
  }
}
setInterval(runQuestionSlaWatch, 60_000);
setTimeout(runQuestionSlaWatch, 40_000);

// ── Напоминания по клиентам: дни рождения контактов, праздники, касания ──
// Раз в день после 08:00 МСК: продажам в чат — кого поздравить (ДР контакта
// сегодня/завтра/через 3 дня, праздник за N дней и в день), и с кем пора
// связаться (плановая дата следующего контакта наступила).
function runCustomerRemindersWatch() {
  try {
    const mskNow = new Date(Date.now() + 3 * 3_600_000);
    if (mskNow.getUTCHours() < 8) return;
    const todayIso = mskNow.toISOString().slice(0, 10);
    const done = db.prepare(`SELECT value FROM app_meta WHERE key='customer_reminders_day'`).get();
    if (done?.value === todayIso) return;
    const dates = upcomingCustomerDates(db, Date.now(), 7);
    const when = days => days === 0 ? 'сегодня' : days === 1 ? 'завтра' : `через ${days} дн.`;
    for (const item of dates) {
      if (item.kind === 'birthday' && [0, 1, 3].includes(item.daysLeft)) {
        notify('sales', `🎂 ${when(item.daysLeft)} день рождения у ${item.contact}` +
          `${item.position ? ` (${item.position})` : ''} — клиент «${item.customer}». Поздравьте и отметьте в карточке клиента (Журнал → Поздравление)`, { category: 'crm' });
      }
      if (item.kind === 'holiday' && (item.daysLeft === 0 || item.daysLeft === item.before)) {
        const active = db.prepare(`SELECT COUNT(DISTINCT customer_name) c FROM trips
          WHERE status<>'rejected' AND ends_at > datetime('now','-90 days')`).get().c;
        notify('sales', `🎉 ${item.name} ${when(item.daysLeft)} — поздравьте клиентов ` +
          `(активных за 90 дней: ${active}); карточки клиентов — «Продажи → Клиенты → 📇»`, null, null, { category: 'crm' });
      }
    }
    for (const row of db.prepare(`SELECT customer_name, next_contact_at FROM customer_profiles
      WHERE next_contact_at IS NOT NULL AND next_contact_at <= ?`).all(todayIso)) {
      notify('sales', `📞 Пора связаться с клиентом «${row.customer_name}» — плановый контакт ` +
        `${String(row.next_contact_at).slice(0, 10).split('-').reverse().join('.')}; откройте карточку клиента (📇), запишите итог и назначьте следующий контакт`, null, null, { category: 'crm' });
    }
    db.prepare(`INSERT INTO app_meta(key,value) VALUES('customer_reminders_day',?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(todayIso);
  } catch (error) {
    console.error('Напоминания по клиентам:', error.message);
  }
}
setInterval(runCustomerRemindersWatch, 15 * 60_000);
setTimeout(runCustomerRemindersWatch, 55_000);

// ── Сигнал логисту: выгрузка через ≤2 часа, следующий рейс не назначен ──
// Правило «минимум два назначенных рейса»: машина не должна освобождаться
// без следующего задания. Раз в 10 минут — одно сообщение логисту со
// списком таких машин (по каждому рейсу — один раз, trips.next_alert_at).
// Ночной сторож порожняка: цепочки меняют и обходными путями (импорт из 1С,
// прямое редактирование), поэтому раз в ночь пересчитываем подгон у всех
// сцепок с будущими рейсами — страховка поверх пересчёта по событиям.
// ── Ночные черновики назначений ──
// Логисты уходят в 20:00, приходят в 08:00 — заявки, подтверждённые вечером,
// ждут утра (медиана 17 часов против дневных 2–3). Ночью система подбирает
// каждой неназначенной заявке с погрузкой в ближайшие 48 часов лучшую
// свободную машину; утром логист подтверждает одним кликом или выбирает
// другую. Черновик — рекомендация, а не назначение: решение за человеком.
// Совместимость кузова заявки и типа ТС — по факту 1300 назначений за
// месяц: «Рефрижератор» и «Изотерм» возит любой тип (это про термо-режим,
// не про кузов), тушевозный груз (туши на крюках) — только тушевоз,
// паллетный — паллетники и допельшток, 41 паллета в 33-й кузов не влезает.
// Из-за отсутствия этого фильтра логисты отклонили 7 из 8 черновиков
// подбора: рекомендация с подгоном 0 км не подходила по кузову.
const BODY_COMPAT = {
  'Тушевоз': ['Тушевоз'],
  'Паллет 33': ['Паллет 33', 'Паллет 41', 'Допельшток'],
  'Паллет 41': ['Паллет 41', 'Допельшток'],
  'Допельшток': ['Допельшток']
};
function bodyTypeMatches(orderBodyType, vehicleTypeName) {
  const allowed = BODY_COMPAT[String(orderBodyType || '').trim()];
  return !allowed || allowed.includes(String(vehicleTypeName || '').trim());
}

function pickVehicleFor(order) {
  const windowFrom = order.window_from;
  const windowTo = order.window_to || windowFrom;
  // Свободна на ВСЁМ окне погрузки: нет рейса, пересекающего окно (в том
  // числе стартующего внутри него — машина обещана другому рейсу), и нет
  // блокирующей диспозиции. Разбор замен 03–04.09: «не успеет по времени»,
  // «у предложенного пересменка» — точечная проверка windowFrom пропускала
  // занятость, начинающуюся часом позже.
  const candidates = db.prepare(`SELECT v.id, v.plate,
      (SELECT name FROM vehicle_types WHERE id=v.type_id) type_name
    FROM vehicles v
    WHERE v.status='work'
      AND NOT EXISTS (SELECT 1 FROM trips t WHERE t.vehicle_id=v.id AND t.status<>'rejected'
        AND datetime(t.starts_at) < datetime(?) AND datetime(t.ends_at) > datetime(?))
      AND NOT EXISTS (SELECT 1 FROM vehicle_dispositions d WHERE d.vehicle_id=v.id
        AND d.kind<>'reserve'
        AND datetime(d.starts_at) < datetime(?) AND datetime(d.ends_at) > datetime(?))
      AND NOT EXISTS (SELECT 1 FROM vehicle_holds h WHERE h.vehicle_id=v.id
        AND datetime(h.until) > datetime('now'))`)
    .all(windowTo, windowFrom, windowTo, windowFrom);
  // Кузовные привычки клиента по истории 90 дней: тип, который клиент
  // никогда не грузил (при 10+ рейсах истории), не рекомендуем — «Хлебпром
  // грузит только паллетники»; доминирующий тип (≥70%) получает приоритет —
  // ЧМПЗ на «Рефрижератор»-заявке всё равно ждёт тушевоз.
  const history = db.prepare(`SELECT vt.name type_name, COUNT(*) n
    FROM trips t JOIN vehicles v ON v.id=t.vehicle_id
    JOIN vehicle_types vt ON vt.id=v.type_id
    WHERE t.customer_name=? AND t.status<>'rejected'
      AND t.starts_at >= datetime('now', '-90 days')
    GROUP BY vt.name`).all(order.customer_name);
  const histTotal = history.reduce((sum, row) => sum + row.n, 0);
  const histOf = type => history.find(row => row.type_name === type)?.n || 0;
  const dominant = histTotal >= 10
    ? history.find(row => row.n / histTotal >= 0.7)?.type_name || null : null;
  // Точка погрузки резолвится один раз на заявку: подгон каждой машины —
  // только позиция сцепки против этой точки, иначе сотня LIKE-поисков
  // адреса на каждую заявку.
  const target = addressPointById(order.from_address_id) || addressPointByText(order.from_point);
  if (!target) return null;
  let best = null;
  let bestDominant = null;
  for (const vehicle of candidates) {
    if (!bodyTypeMatches(order.body_type, vehicle.type_name)) continue;
    // Тип, которого нет в истории клиента (10+ рейсов), — не предлагаем.
    if (histTotal >= 10 && histOf(vehicle.type_name) === 0) continue;
    const origin = vehiclePositionBefore(vehicle.id, windowFrom);
    if (!origin || !Number.isFinite(origin.latitude)) continue;
    const km = roadKm(origin.latitude, origin.longitude, target.latitude, target.longitude);
    if (!best || km < best.km) best = { vehicle, km };
    if (dominant && vehicle.type_name === dominant && (!bestDominant || km < bestDominant.km)) {
      bestDominant = { vehicle, km };
    }
  }
  // Доминирующий тип клиента побеждает, если он не сильно дальше (до +150 км).
  if (bestDominant && best && bestDominant.vehicle.id !== best.vehicle.id &&
      bestDominant.km - best.km <= 150) {
    best = bestDominant;
  }
  return best;
}
// ── Утренние направления для продаж ──
// Продажам не хватало ответа «из какого региона и куда брать грузы»: в
// 06:55 МСК считаем, куда машины ПРИЕДУТ в ближайшие 72 часа, и сколько из
// этих зон уже есть исходящих заявок. Дефицит — готовый список прозвона:
// продаём маршруты (обратные плечи кругов), а не одиночные рейсы.
// ── Зависшие перегоны ──
// На проде три перегона висели «в пути» на 1–2 суток после планового
// прибытия без единой отметки: машина давно в Пензе на пересменке, а по
// данным — едет. Пока перегон открыт, сцепка числится в пути: место
// неверное, стыковка её не видит. Через 6 часов просрочки — напоминание
// диспетчерам; через 24 часа — автозакрытие плановым временем с пометкой
// (для сервисных целей риск мал, а место сцепки становится честным).
// ── Ревизия зазоров между назначенными рейсами ──
// Три раза в день (10:00, 14:00, 16:00 МСК) сверяем назначенный план: пары
// заданий сцепки, между которыми простой больше 12 часов чистыми — за
// вычетом времени подгона и без диспозиции в зазоре. Отчёт уходит лично
// каждому действующему сотруднику: 133 часа таких дыр за первый прогон —
// это ~102 т₽ маржи, которые закрываются сдвигом рейса, локалкой или спотом.
// Черновики подбора живут до утра, а парк меняется ночью: ремонт р264ма58
// продлили в 08:23 МСК — через час после ночного подбора, и черновик
// «свободна, подгон 6 км» остался висеть на машину в ремонте. Любое
// изменение диспозиций или брони машины сбрасывает её активные черновики —
// следующий круг сторожа пересчитает по свежим данным.
function invalidateDraftsForVehicle(vehicleId, exceptOrderId = null) {
  if (!vehicleId) return;
  // exceptOrderId: при назначении рейса черновик САМОЙ назначаемой заявки
  // не трогаем — его итог (accepted/overridden + причина) фиксируется
  // сразу после, иначе статистика доверия подбору теряла бы запись.
  db.prepare(`DELETE FROM assign_drafts WHERE vehicle_id=? AND outcome IS NULL
    AND (? IS NULL OR order_id<>?)`).run(vehicleId, exceptOrderId, exceptOrderId);
}

const GAP_REVIEW_HOURS_MSK = [10, 14, 16];
function runGapReviewWatch() {
  try {
    const msk = new Date(Date.now() + 3 * 3_600_000);
    const hour = msk.getUTCHours();
    if (!GAP_REVIEW_HOURS_MSK.includes(hour)) return;
    const slot = `${msk.toISOString().slice(0, 10)}:${hour}`;
    if (db.prepare(`SELECT value FROM app_meta WHERE key='gap_review_slot'`).get()?.value === slot) return;
    const rows = db.prepare(`SELECT t.id, t.vehicle_id, t.order_no, t.starts_at, t.ends_at,
        t.unloaded_at, t.empty_km, v.plate,
        (SELECT name FROM zones WHERE id=t.to_zone_id) to_name
      FROM trips t JOIN vehicles v ON v.id=t.vehicle_id
      WHERE t.status IN ('plan','run') ORDER BY t.vehicle_id, t.starts_at`).all();
    const byVehicle = new Map();
    for (const row of rows) {
      if (!byVehicle.has(row.vehicle_id)) byVehicle.set(row.vehicle_id, []);
      byVehicle.get(row.vehicle_id).push(row);
    }
    const mskLabel = mskStamp;
    const gaps = [];
    for (const list of byVehicle.values()) {
      for (let i = 1; i < list.length; i += 1) {
        const prev = list[i - 1];
        const next = list[i];
        const prevEnd = Date.parse(prev.unloaded_at
          ? String(prev.unloaded_at).replace(' ', 'T') + (String(prev.unloaded_at).includes('Z') ? '' : 'Z')
          : prev.ends_at);
        const feedH = (Number(next.empty_km) || 0) / 50 * 1.5;
        const gapH = (Date.parse(next.starts_at) - prevEnd) / 3_600_000 - feedH;
        if (gapH <= 12) continue;
        const covered = db.prepare(`SELECT COUNT(*) c FROM vehicle_dispositions
          WHERE vehicle_id=? AND datetime(starts_at) < datetime(?) AND datetime(ends_at) > datetime(?)`)
          .get(prev.vehicle_id, next.starts_at, new Date(prevEnd).toISOString()).c;
        if (covered) continue;
        gaps.push({ plate: prev.plate, gapH: Math.round(gapH), prevNo: prev.order_no,
          prevTo: prev.to_name, prevEnd, nextNo: next.order_no, nextStart: Date.parse(next.starts_at) });
      }
    }
    db.prepare(`INSERT INTO app_meta(key,value) VALUES('gap_review_slot',?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(slot);
    if (!gaps.length) return;
    gaps.sort((a, b) => b.gapH - a.gapH);
    const totalH = gaps.reduce((sum, gap) => sum + gap.gapH, 0);
    const lines = gaps.slice(0, 12).map(gap =>
      `${gap.plate}: после №${gap.prevNo} (${gap.prevTo}) до №${gap.nextNo} — ~${gap.gapH} ч ` +
      `(${mskLabel(gap.prevEnd)} → ${mskLabel(gap.nextStart)} МСК)`);
    const text = `📋 Ревизия плана (${hour}:00): у ${gaps.length} пар заданий завышен простой между ` +
      `рейсами (больше 12 ч сверх подгона, без ремонта/пересменки) — суммарно ${totalH} ч ` +
      `≈ ${Math.round(totalH * 770 / 1000)} т₽ маржи. ${lines.join('; ')}${gaps.length > 12
        ? ` и ещё ${gaps.length - 12}` : ''}. Сдвиньте следующий рейс раньше, вставьте локалку ` +
      `или спот — «Логист → Сцепки», «⏭ стыковка плеча»`;
    notifyEveryone(text, null, null, { category: 'gap_review' });
  } catch (error) {
    console.error('Ревизия зазоров:', error.message);
  }
}
setInterval(runGapReviewWatch, 10 * 60_000);

// ── Ночной сторож «рейс не вышел в окно» ──
// Кейс 01.09: рейс Черкизово с окном 23:00 ночью не вышел, ночью на это
// никто не среагировал, и замену провели только в 09:00 — окно сгорело на
// 10 часов ещё до начала смены. Круглосуточно: плановый выход прошёл 2+
// часа, задания водителю нет и фактов движения нет — эскалация логистам
// и диспетчерам, один раз на рейс (night_alert в app_meta по id).
// ── Сторож стыка «подтверждено → внесено в 1С» ──
// Норма 30 минут; разбор 01.09 показал медиану 144 мин и хвост 18,8 часа —
// главная просадка диспетчерской. Каждые 30 минут: рейсы, подтверждённые
// больше 45 минут назад без внесения (и без «внесу позже»), — списком
// диспетчерам, не чаще раза в 2 часа.
function runEntered1cWatch() {
  try {
    const last = Number(db.prepare(`SELECT value FROM app_meta WHERE key='entered_1c_watch_at'`).get()?.value || 0);
    if (Date.now() - last < 2 * 3_600_000) return;
    const rows = db.prepare(`SELECT t.order_no, v.plate, t.logist_confirmed_at,
        (SELECT name FROM zones WHERE id=t.from_zone_id) fz,
        (SELECT name FROM zones WHERE id=t.to_zone_id) tz
      FROM trips t JOIN vehicles v ON v.id=t.vehicle_id
      WHERE t.status='plan' AND t.entered_1c_at IS NULL AND t.deferred_1c_at IS NULL
        AND t.logist_confirmed_at IS NOT NULL
        AND datetime(t.logist_confirmed_at) < datetime('now','-45 minutes')`).all();
    if (!rows.length) return;
    const minutes = iso => Math.round((Date.now() - Date.parse(String(iso).replace(' ', 'T') +
      (String(iso).includes('Z') || String(iso).includes('+') ? '' : 'Z'))) / 60_000);
    const lines = rows.slice(0, 10).map(row =>
      `${row.plate} №${row.order_no || '—'} ${row.fz}→${row.tz} (ждёт ${minutes(row.logist_confirmed_at)} мин)`);
    notify('dispatcher', `🧾 Заказы не внесены в 1С дольше 45 минут после подтверждения ` +
      `(норма — 30): ${lines.join('; ')}${rows.length > 10 ? ` и ещё ${rows.length - 10}` : ''}. ` +
      `Внесите или отметьте «⏭ Внесу позже» — стык «подтверждено → 1С» главная просадка смены`, null, null, { category: 'debt_1c' });
    db.prepare(`INSERT INTO app_meta(key,value) VALUES('entered_1c_watch_at',?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(String(Date.now()));
  } catch (error) {
    console.error('Сторож стыка 1С:', error.message);
  }
}
setInterval(runEntered1cWatch, 30 * 60_000);

// ── Бот водителей «Пегас Водитель» ──
// Отдельный бот (settings.telegram.driverBotToken): водитель привязывается
// кнопкой «поделиться контактом» (матч по телефону справочника), получает
// задание на рейс БЕЗ сумм и отмечает этапы кнопками — факты ложатся в
// trip_stops теми же полями, что отметки диспетчера.
const driverBotToken = () => telegramConfig().driverBotToken || null;
const digitsPhone = value => String(value || '').replace(/\D/g, '').slice(-10);

// Следующая кнопка этапа: одна актуальная, по состоянию точек рейса.
function nextDriverStep(tripId) {
  const stops = db.prepare(`SELECT id, kind, seq, point, actual_arrival, actual_departure
    FROM trip_stops WHERE trip_id=? ORDER BY seq`).all(tripId);
  for (const stop of stops) {
    if (stop.actual_departure) continue;
    const isFirst = stop.seq === stops[0].seq;
    const isLast = stop.seq === stops[stops.length - 1].seq;
    if (!stop.actual_arrival) {
      return { stopId: stop.id, phase: 'arr', isLast,
        label: isFirst ? '📦 Прибыл на погрузку' : isLast ? '📥 Прибыл на выгрузку' : '📍 Прибыл на точку' };
    }
    return { stopId: stop.id, phase: 'dep', isLast,
      label: isFirst ? '✅ Погрузился, выехал' : isLast ? '🏁 Выгрузился' : '➡ Убыл с точки' };
  }
  return null;
}

// Плашки этапности для водителя — как чек-лист у диспетчера: что уже
// отмечено (с фактическим временем МСК), какой этап сейчас, что впереди.
function driverProgressText(tripId) {
  const stops = db.prepare(`SELECT id, kind, seq, actual_arrival, actual_departure,
    planned_arrival FROM trip_stops WHERE trip_id=? ORDER BY seq`).all(tripId);
  if (!stops.length) return '';
  const msk = iso => iso ? `${mskStamp(iso)} МСК` : '';
  const current = nextDriverStep(tripId);
  const lines = ['Этапы рейса:'];
  for (const stop of stops) {
    const isFirst = stop.seq === stops[0].seq;
    const isLast = stop.seq === stops[stops.length - 1].seq;
    const steps = [
      ['arr', isFirst ? '📦 Прибыл на погрузку' : isLast ? '📥 Прибыл на выгрузку' : '📍 Прибыл на точку', stop.actual_arrival],
      ['dep', isFirst ? '✅ Погрузился, выехал' : isLast ? '🏁 Выгрузился' : '➡ Убыл с точки', stop.actual_departure]];
    for (const [phase, label, fact] of steps) {
      const isCurrent = current && current.stopId === stop.id && current.phase === phase;
      lines.push(fact ? `✅ ${label} — ${msk(fact)}`
        : isCurrent ? `▶️ ${label} — жмите кнопку по факту${phase === 'arr' && stop.planned_arrival ? ` (план ${msk(stop.planned_arrival)})` : ''}`
        : `⬜ ${label}`);
    }
  }
  return lines.join('\n');
}

// Текст задания водителю: маршрут и точки с плановыми временами — без
// ставок и сумм (деньги водителю в задании не показываем).
function driverAssignmentText(trip) {
  const stops = db.prepare(`SELECT kind, point, planned_arrival FROM trip_stops
    WHERE trip_id=? ORDER BY seq`).all(trip.id);
  const mskTime = iso => iso ? mskStamp(iso) : '—';
  const lines = [`🚚 Задание на рейс${trip.order_no ? ` (заказ № ${trip.order_no})` : ''}`,
    `${trip.from_point || ''} → ${trip.to_point || ''}`.trim(),
    `Выход: ${mskTime(trip.starts_at)} (МСК)`];
  for (const stop of stops) {
    lines.push(`${stop.kind === 'P' ? '📦 Погрузка' : stop.kind === 'D' ? '📥 Выгрузка' : '📍 Точка'}: `
      + `${stop.point || '—'}${stop.planned_arrival ? ` · план ${mskTime(stop.planned_arrival)}` : ''}`);
  }
  if (trip.temperature_mode) lines.push(`🌡 Режим: ${trip.temperature_mode}`);
  if (trip.body_type) lines.push(`🚛 Кузов: ${trip.body_type}`);
  const progress = driverProgressText(trip.id);
  if (progress) lines.push('', progress);
  lines.push('', 'Отмечайте этапы кнопкой под сообщением — диспетчер видит их сразу. Кнопка «📋 Моё задание» внизу пришлёт задание с актуальной кнопкой заново.');
  return lines.join('\n');
}

function driverForTrip(trip) {
  const byLink = db.prepare(`SELECT d.* FROM drivers d
    WHERE d.vehicle_id=? AND d.telegram_chat_id IS NOT NULL AND d.status<>'fired'
    LIMIT 1`).get(trip.vehicle_id);
  if (byLink) return byLink;
  // Фолбэк: закрепление исторически живёт текстом в vehicles.driver_name
  // («Ниговорин»), а drivers.vehicle_id бывает пуст — матчим по началу
  // ФИО, только если кандидат ровно один (однофамильцы не угадываются).
  const name = String(db.prepare('SELECT driver_name FROM vehicles WHERE id=?')
    .get(trip.vehicle_id)?.driver_name || '').trim();
  if (name.length < 3) return null;
  const candidates = db.prepare(`SELECT d.* FROM drivers d
    WHERE d.full_name LIKE ? AND d.telegram_chat_id IS NOT NULL AND d.status<>'fired'`)
    .all(`${name}%`);
  return candidates.length === 1 ? candidates[0] : null;
}

// Отправить/обновить задание водителю с кнопкой текущего этапа.
function sendDriverAssignment(tripId) {
  try {
    if (!driverBotToken()) return;
    const trip = db.prepare('SELECT * FROM trips WHERE id=?').get(tripId);
    if (!trip || trip.status === 'rejected') return;
    const driver = driverForTrip(trip);
    if (!driver) return;
    ensureTripStops(db, tripId);
    const step = nextDriverStep(tripId);
    tgApi('sendMessage', {
      chat_id: driver.telegram_chat_id,
      text: driverAssignmentText(trip),
      reply_markup: step ? { inline_keyboard: [[{ text: step.label,
        callback_data: `st|${step.stopId}|${step.phase}` }]] } : undefined
    }, driverBotToken());
  } catch (error) { console.error('sendDriverAssignment:', error.message); }
}

// Обработка нажатия этапа: проверка принадлежности, хронологии — и факт.
function applyDriverStep(chatId, stopId, phase) {
  const driver = db.prepare(`SELECT * FROM drivers WHERE telegram_chat_id=?`).get(String(chatId));
  if (!driver) return { text: 'Чат не привязан — отправьте свой контакт кнопкой ниже.' };
  const stop = db.prepare(`SELECT s.*, t.vehicle_id, t.status trip_status FROM trip_stops s
    JOIN trips t ON t.id = s.trip_id WHERE s.id=?`).get(stopId);
  if (!stop || stop.vehicle_id !== driver.vehicle_id || stop.trip_status === 'rejected') {
    return { text: 'Эта кнопка от другого рейса — актуальное задание пришлём отдельно.' };
  }
  const nowIso = new Date().toISOString();
  if (phase === 'arr' && !stop.actual_arrival) {
    // Хронология: прибытие не раньше события предыдущей точки.
    const previous = db.prepare(`SELECT actual_departure, actual_arrival FROM trip_stops
      WHERE trip_id=? AND seq<? ORDER BY seq DESC LIMIT 1`).get(stop.trip_id, stop.seq);
    const prevMoment = previous && (previous.actual_departure || previous.actual_arrival);
    if (prevMoment && Date.parse(nowIso) < Date.parse(prevMoment)) {
      return { text: 'Сначала отметьте предыдущую точку.' };
    }
    db.prepare(`UPDATE trip_stops SET actual_arrival=?, work_started_at=COALESCE(work_started_at,?)
      WHERE id=?`).run(nowIso, nowIso, stopId);
  } else if (phase === 'dep' && stop.actual_arrival && !stop.actual_departure) {
    db.prepare(`UPDATE trip_stops SET work_finished_at=COALESCE(work_finished_at,?),
      actual_departure=? WHERE id=?`).run(nowIso, nowIso, stopId);
  } else {
    return { text: 'Этот этап уже отмечен.' };
  }
  audit(db, null, 'driver-step', 'stop', stopId,
    { phase, driver: driver.full_name, via: 'telegram' }, 'driver-bot');
  const next = nextDriverStep(stop.trip_id);
  const finishedUnload = phase === 'dep' && !next;
  // После убытия с точки спрашиваем прогноз прибытия на следующую —
  // водитель знает дорогу лучше расчёта.
  const askEta = phase === 'dep' && next && next.phase === 'arr'
    ? { stopId: next.stopId } : null;
  const progress = driverProgressText(stop.trip_id);
  return {
    text: (finishedUnload
      ? 'Не забудь проверить печати в документах и сдать их во-время. Благодарю за труд! Доброго пути!'
      : '✅ Отмечено, диспетчер видит.') + (progress ? `\n\n${progress}` : ''),
    next, askEta, tripId: stop.trip_id
  };
}

// Поллер бота водителей: контакт → привязка, кнопки → этапы, текст → вопрос.
async function runDriverBotPoll() {
  const token = driverBotToken();
  if (!token) return;
  try {
    const offset = Number(db.prepare(`SELECT value FROM app_meta WHERE key='tgd_offset'`).get()?.value || 0);
    const answer = await tgApi('getUpdates', { offset: offset + 1, timeout: 0,
      allowed_updates: ['message', 'callback_query'] }, token);
    if (!answer?.ok) return;
    for (const update of answer.result || []) {
      db.prepare(`INSERT INTO app_meta(key,value) VALUES('tgd_offset',?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(String(update.update_id));
      // Кнопка этапа
      if (update.callback_query) {
        const query = update.callback_query;
        const [tag, stopId, phase] = String(query.data || '').split('|');
        if (tag === 'st') {
          const result = applyDriverStep(query.message?.chat?.id, stopId, phase);
          tgApi('answerCallbackQuery', { callback_query_id: query.id, text: '✓' }, token);
          // Сначала ДОСТАВИТЬ новое сообщение с кнопкой и только при успехе
          // гасить кнопку под старым: если сеть моргнула на отправке, у
          // водителя останется хотя бы старая кнопка (случай Ниговорина
          // 05.09 — «все кнопки исчезли» после «Прибыл на выгрузку»).
          const sent = result.text ? await tgApi('sendMessage', { chat_id: query.message.chat.id,
            text: result.text,
            reply_markup: result.next ? { inline_keyboard: [[{ text: result.next.label,
              callback_data: `st|${result.next.stopId}|${result.next.phase}` }]] } : undefined }, token) : null;
          if (sent?.ok) tgApi('editMessageReplyMarkup', { chat_id: query.message.chat.id,
            message_id: query.message.message_id }, token);
          if (result.askEta) {
            tgApi('sendMessage', { chat_id: query.message.chat.id,
              text: '🕐 Когда планируете прибыть на следующую точку? Прогноз увидит диспетчер.',
              reply_markup: { inline_keyboard: [
                [{ text: 'через 2 ч', callback_data: `eta|${result.askEta.stopId}|2` },
                 { text: 'через 4 ч', callback_data: `eta|${result.askEta.stopId}|4` }],
                [{ text: 'через 6 ч', callback_data: `eta|${result.askEta.stopId}|6` },
                 { text: 'завтра', callback_data: `eta|${result.askEta.stopId}|14` }]
              ] } }, token);
          }
        } else if (tag === 'eta') {
          const hours = Number(phase);
          const driver = db.prepare(`SELECT * FROM drivers WHERE telegram_chat_id=?`)
            .get(String(query.message?.chat?.id || ''));
          const stop = driver ? db.prepare(`SELECT s.*, t.vehicle_id FROM trip_stops s
            JOIN trips t ON t.id = s.trip_id WHERE s.id=?`).get(stopId) : null;
          tgApi('answerCallbackQuery', { callback_query_id: query.id, text: '✓' }, token);
          if (driver && stop && stop.vehicle_id === driver.vehicle_id ||
              (driver && stop && driverForTrip({ vehicle_id: stop.vehicle_id, id: stop.trip_id })?.id === driver.id)) {
            const eta = new Date(Date.now() + hours * 3_600_000).toISOString();
            db.prepare(`UPDATE trip_stops SET driver_eta=? WHERE id=?`).run(eta, stopId);
            const mskEta = mskStamp(eta);
            const confirmed = await tgApi('sendMessage', { chat_id: query.message.chat.id,
              text: `Принял: примерно к ${mskEta} (МСК). Диспетчер видит прогноз.` }, token);
            if (confirmed?.ok) tgApi('editMessageReplyMarkup', { chat_id: query.message.chat.id,
              message_id: query.message.message_id }, token);
            // Прогноз сильно позже плана — диспетчеру знать заранее.
            if (stop.planned_arrival && Date.parse(eta) - Date.parse(stop.planned_arrival) > 2 * 3_600_000) {
              const plate = db.prepare('SELECT plate FROM vehicles WHERE id=?').get(stop.vehicle_id)?.plate || '';
              notify('dispatcher', `📱 Водитель ${driver.full_name}${plate ? ` (${plate})` : ''} прогнозирует прибытие `
                + `«${(stop.point || '').slice(0, 40)}» к ${mskEta} МСК — позже плана. Учтите в контроле и предупредите клиента`,
              'trip', stop.trip_id, { category: 'order_deadlines' });
            }
            audit(db, null, 'driver-eta', 'stop', stopId,
              { hours, driver: driver.full_name }, 'driver-bot');
          }
        }
        continue;
      }
      const message = update.message;
      const chatId = String(message?.chat?.id || '');
      if (!chatId) continue;
      // Привязка по контакту
      if (message.contact?.phone_number) {
        const phone = digitsPhone(message.contact.phone_number);
        const driver = phone.length === 10 ? db.prepare(`SELECT * FROM drivers
          WHERE status<>'fired' AND replace(replace(replace(replace(replace(COALESCE(phone,''),'+',''),' ',''),'-',''),'(',''),')','') LIKE ?
          LIMIT 1`).get(`%${phone}`) : null;
        if (driver) {
          db.prepare(`UPDATE drivers SET telegram_chat_id=? WHERE id=?`).run(chatId, driver.id);
          audit(db, null, 'driver-tg-link', 'driver', driver.id, { via: 'contact' }, 'driver-bot');
          tgApi('sendMessage', { chat_id: chatId,
            text: `✅ Привязано: ${driver.full_name}. Сюда будут приходить задания на рейсы — этапы отмечайте кнопками. Вопрос диспетчеру можно написать прямо здесь.`,
            reply_markup: { keyboard: [[{ text: '📋 Моё задание' }]],
              resize_keyboard: true, is_persistent: true } }, token);
          // Активный рейс уже есть — сразу шлём задание.
          const active = db.prepare(`SELECT id FROM trips WHERE vehicle_id=? AND status IN ('plan','run')
            ORDER BY starts_at LIMIT 1`).get(driver.vehicle_id);
          if (active) sendDriverAssignment(active.id);
        } else {
          tgApi('sendMessage', { chat_id: chatId,
            text: 'Номер не найден в справочнике водителей — обратитесь к диспетчеру, пусть проверит ваш телефон в планере.' }, token);
        }
        continue;
      }
      const text = String(message.text || '').trim();
      if (!text) continue;
      const driver = db.prepare(`SELECT * FROM drivers WHERE telegram_chat_id=?`).get(chatId);
      // «📋 Моё задание» — прислать актуальное задание с кнопкой этапа в
      // любой момент (погрузка/выгрузка раньше слота — отметки не ждут план).
      if (driver && /Моё задание/i.test(text)) {
        const active = db.prepare(`SELECT id FROM trips WHERE vehicle_id=? AND status IN ('plan','run')
          ORDER BY starts_at LIMIT 1`).get(driver.vehicle_id)
          || (() => { const v = db.prepare(`SELECT id FROM vehicles WHERE driver_name IS NOT NULL AND ? LIKE driver_name || '%'`).get(driver.full_name);
            return v ? db.prepare(`SELECT id FROM trips WHERE vehicle_id=? AND status IN ('plan','run') ORDER BY starts_at LIMIT 1`).get(v.id) : null; })();
        if (active) sendDriverAssignment(active.id);
        else tgApi('sendMessage', { chat_id: chatId, text: 'Активного рейса сейчас нет — задание придёт при назначении.' }, token);
        continue;
      }
      if (/^\/start/.test(text) || !driver) {
        tgApi('sendMessage', { chat_id: chatId,
          text: driver ? 'Вы привязаны. Вопрос диспетчеру — просто напишите его здесь.'
            : 'Здравствуйте! Это бот водителей ПегасЛогистик. Нажмите кнопку ниже, чтобы привязаться.',
          reply_markup: driver ? undefined : { keyboard: [[{ text: '📱 Поделиться контактом',
            request_contact: true }]], resize_keyboard: true, one_time_keyboard: true } }, token);
        continue;
      }
      // Свободный текст — вопрос диспетчеру (та же механика SLA 10 минут).
      const activeTrip = db.prepare(`SELECT id FROM trips WHERE vehicle_id=? AND status IN ('plan','run')
        ORDER BY starts_at LIMIT 1`).get(driver.vehicle_id);
      const questionId = randomUUID();
      db.prepare(`INSERT INTO driver_questions(id,vehicle_id,trip_id,driver_name,phone,topic,note,opened_by)
        VALUES(?,?,?,?,?,?,?,NULL)`).run(questionId, driver.vehicle_id, activeTrip?.id || null,
        driver.full_name, driver.phone || '', 'other', `TG: ${text.slice(0, 480)}`);
      const plate = db.prepare('SELECT plate FROM vehicles WHERE id=?').get(driver.vehicle_id)?.plate || '';
      notify('dispatcher', `📱 Вопрос водителя из Telegram (${driver.full_name}${plate ? ` · ${plate}` : ''}): `
        + `«${text.slice(0, 200)}» — ответьте звонком или через карточку вопроса`,
      'question', questionId, { category: 'driver_questions' });
      tgApi('sendMessage', { chat_id: chatId,
        text: 'Передал диспетчеру — ответят в ближайшие минуты.' }, token);
    }
  } catch (error) { console.error('runDriverBotPoll:', error.message); }
}
setInterval(runDriverBotPoll, 20_000);
setTimeout(runDriverBotPoll, 40_000);

// Пинги по ходу рейса: расчётное прибытие прошло, а отметки нет — «вы у
// точки?»; стоит на точке дольше норматива — «как дела?». Пинг несёт
// кнопку актуального этапа: водителю остаётся нажать. Повтор — не чаще
// раза в 3 часа на фазу (память в app_meta, старые записи чистятся).
function runDriverPingWatch() {
  try {
    if (!driverBotToken()) return;
    const marks = JSON.parse(db.prepare(`SELECT value FROM app_meta
      WHERE key='driver_ping_marks'`).get()?.value || '{}');
    const nowMs = Date.now();
    const REPEAT_MS = 3 * 3_600_000;
    const trips = db.prepare(`SELECT t.* FROM trips t
      WHERE t.status='run'`).all();
    for (const trip of trips) {
      const driver = driverForTrip(trip);
      if (!driver) continue;
      const step = nextDriverStep(trip.id);
      if (!step) continue;
      const stop = db.prepare(`SELECT * FROM trip_stops WHERE id=?`).get(step.stopId);
      if (!stop) continue;
      let text = null;
      let markKey = null;
      const arrBase = Math.max(
        stop.planned_arrival ? Date.parse(stop.planned_arrival) : 0,
        stop.driver_eta ? Date.parse(stop.driver_eta) : 0);
      if (step.phase === 'arr' && arrBase &&
          nowMs - arrBase > 45 * 60_000) {
        markKey = `${stop.id}|arr`;
        text = `📍 По расчёту вы уже у точки «${(stop.point || '').slice(0, 60)}» — прибыли? `
          + 'Если да — нажмите кнопку; если задерживаетесь, напишите, что случилось.';
      } else if (step.phase === 'dep' && stop.actual_arrival &&
          nowMs - Date.parse(stop.actual_arrival) > 3 * 3_600_000) {
        const hours = Math.floor((nowMs - Date.parse(stop.actual_arrival)) / 3_600_000);
        markKey = `${stop.id}|dep`;
        text = `⏳ Вы на точке «${(stop.point || '').slice(0, 60)}» уже ${hours} ч — как дела? `
          + 'Если закончили — нажмите кнопку; если держат, напишите причину — передадим диспетчеру.';
      }
      if (!text || (marks[markKey] && nowMs - marks[markKey] < REPEAT_MS)) continue;
      tgApi('sendMessage', { chat_id: driver.telegram_chat_id, text,
        reply_markup: { inline_keyboard: [[{ text: step.label,
          callback_data: `st|${step.stopId}|${step.phase}` }]] } }, driverBotToken());
      marks[markKey] = nowMs;
    }
    // Чистка меток старше 3 суток.
    for (const key of Object.keys(marks)) {
      if (nowMs - marks[key] > 3 * 86_400_000) delete marks[key];
    }
    db.prepare(`INSERT INTO app_meta(key,value) VALUES('driver_ping_marks',?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(JSON.stringify(marks));
  } catch (error) { console.error('runDriverPingWatch:', error.message); }
}
setInterval(runDriverPingWatch, 15 * 60_000);
setTimeout(runDriverPingWatch, 60_000);

// Напоминание о выходе: за 2–3 часа до планового старта, раз на рейс.
function runDriverRemindWatch() {
  try {
    if (!driverBotToken()) return;
    const memory = JSON.parse(db.prepare(`SELECT value FROM app_meta
      WHERE key='driver_remind_ids'`).get()?.value || '[]');
    const seen = new Set(memory);
    const rows = db.prepare(`SELECT id, vehicle_id, starts_at, from_point, to_point FROM trips
      WHERE status='plan' AND starts_at > datetime('now', '+1 hour')
        AND starts_at <= datetime('now', '+3 hours')`).all();
    for (const trip of rows) {
      if (seen.has(trip.id)) continue;
      const driver = driverForTrip(trip);
      if (!driver) continue;
      const mskTime = new Date(Date.parse(trip.starts_at) + 3 * 3_600_000)
        .toISOString().replace('T', ' ').slice(11, 16);
      tgApi('sendMessage', { chat_id: driver.telegram_chat_id,
        text: `⏰ Напоминание: выход в ${mskTime} (МСК) — ${trip.from_point || ''} → ${trip.to_point || ''}` },
      driverBotToken());
      seen.add(trip.id);
    }
    db.prepare(`INSERT INTO app_meta(key,value) VALUES('driver_remind_ids',?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
      .run(JSON.stringify([...seen].slice(-500)));
  } catch (error) { console.error('runDriverRemindWatch:', error.message); }
}
setInterval(runDriverRemindWatch, 10 * 60_000);
setTimeout(runDriverRemindWatch, 50_000);

// ── Поллер Telegram: привязка чатов командой /start КОД ──
// Long polling раз в 20 сек (вебхук не поставить: самоподписанный
// сертификат). Код выдаёт планер (кнопка «🔔 Уведомления»), живёт 15 минут.
async function runTelegramPoll() {
  if (!telegramConfig().botToken) return;
  try {
    const offset = Number(db.prepare(`SELECT value FROM app_meta WHERE key='tg_offset'`).get()?.value || 0);
    const answer = await tgApi('getUpdates', { offset: offset + 1, timeout: 0, allowed_updates: ['message'] });
    if (!answer?.ok) return;
    const result = answer.result;
    for (const update of result || []) {
      db.prepare(`INSERT INTO app_meta(key,value) VALUES('tg_offset',?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(String(update.update_id));
      const chatId = String(update.message?.chat?.id || '');
      const messageText = String(update.message?.text || '').trim();
      if (!chatId || !messageText) continue;
      const codeMatch = messageText.match(/^\/start\s+([A-Za-z0-9]{4,12})$/);
      if (codeMatch) {
        const key = `tg_link_${codeMatch[1].toUpperCase()}`;
        const link = db.prepare(`SELECT value FROM app_meta WHERE key=?`).get(key);
        const parsed = link ? JSON.parse(link.value) : null;
        if (parsed && Date.now() < parsed.exp) {
          db.prepare(`UPDATE users SET telegram_chat_id=?,
            telegram_mode=COALESCE(telegram_mode,'critical') WHERE id=?`).run(chatId, parsed.userId);
          db.prepare(`DELETE FROM app_meta WHERE key=?`).run(key);
          const user = db.prepare(`SELECT full_name, username, role, roles FROM users WHERE id=?`).get(parsed.userId);
          sendTelegramTo([chatId], `✅ Привязано: ${user?.full_name || user?.username || ''}. `
            + 'Сюда будут приходить аварийные уведомления планера. Режим меняется в планере '
            + '(кнопка «🔔»), отвязка — командой /stop.');
          // Руководителю и админу сразу шлём последний «Отчёт дня» — живая
          // проверка канала и сразу польза.
          if (['boss', 'admin'].includes(user?.role) || /"(boss|admin)"/.test(user?.roles || '')) {
            const report = db.prepare(`SELECT text FROM messages
              WHERE kind='auto' AND text LIKE '%Отчёт дня%'
              ORDER BY created_at DESC LIMIT 1`).get();
            if (report) sendTelegramTo([chatId], report.text);
          }
        } else {
          sendTelegramTo([chatId], 'Код не найден или устарел — возьмите новый в планере (кнопка «🔔»).');
        }
      } else if (/^\/stop$/.test(messageText)) {
        db.prepare(`UPDATE users SET telegram_chat_id=NULL WHERE telegram_chat_id=?`).run(chatId);
        sendTelegramTo([chatId], 'Отвязано. Вернуться: кнопка «🔔» в планере.');
      }
    }
  } catch { /* сеть/телеграм недоступны — следующий тик */ }
}
setInterval(runTelegramPoll, 20_000);
setTimeout(runTelegramPoll, 30_000);

// ── Регулятор баланса парк↔сетка ──
// Баланс дня: потребность сетки (рейсы слотов × цикл плеча) против парка
// (занято рейсами + свободно; недоступные исключены). Общий расчёт для
// сторожа и, через /api/fleet-plan, для Плана парка.
function balanceOfDay(dayMs) {
  const from = new Date(dayMs).toISOString();
  const to = new Date(dayMs + 86_400_000).toISOString();
  const weekday = new Date(dayMs).getUTCDay();
  const need = db.prepare(`SELECT COALESCE(SUM(per_day * ((COALESCE(transit_hours,24)) + 8) / 24.0),0) v
    FROM delivery_slots WHERE weekday=?`).get(weekday).v;
  const work = db.prepare(`SELECT COUNT(*) n FROM vehicles WHERE status='work'`).get().n;
  const busy = db.prepare(`SELECT COUNT(DISTINCT vehicle_id) n FROM trips
    WHERE status!='rejected' AND starts_at < ? AND COALESCE(unloaded_at, ends_at) > ?`)
    .get(to, from).n;
  const unavail = db.prepare(`SELECT COUNT(DISTINCT d.vehicle_id) n FROM vehicle_dispositions d
    WHERE d.starts_at < ? AND d.ends_at > ? AND d.vehicle_id NOT IN (
      SELECT vehicle_id FROM trips WHERE status!='rejected' AND starts_at < ? AND COALESCE(unloaded_at, ends_at) > ?)`)
    .get(to, from, to, from).n;
  const free = Math.max(0, work - busy - unavail);
  return { need, busy, unavail, free, balance: busy + free - need };
}

// Сторож «красная среда»: раз в сутки смотрит баланс на 5 дней вперёд с
// поправкой на разовые заявки сверх сетки (факт последних 14 дней). Узкий
// день сигналится логисту и руководителю ЗАРАНЕЕ, с рычагами дня.
function runBalanceWatch() {
  try {
    const mskHour = (new Date().getUTCHours() + 3) % 24;
    if (mskHour < 8) return;
    const todayIso = new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
    const slot = db.prepare(`SELECT value FROM app_meta WHERE key='balance_watch_day'`).get()?.value;
    if (slot === todayIso) return;
    db.prepare(`INSERT INTO app_meta(key,value) VALUES('balance_watch_day',?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(todayIso);
    const dayStart = Date.parse(`${todayIso}T00:00:00Z`);
    // Разовые сверх сетки: занято − потребность по прошедшим дням.
    let extra = 0;
    let extraDays = 0;
    for (let back = 1; back <= 14; back += 1) {
      const past = balanceOfDay(dayStart - back * 86_400_000);
      if (past.busy > 0) { extra += Math.max(0, past.busy - past.need); extraDays += 1; }
    }
    const extraAvg = extraDays ? extra / extraDays : 0;
    const alerts = [];
    for (let ahead = 1; ahead <= 5; ahead += 1) {
      const dayMs = dayStart + ahead * 86_400_000;
      const day = balanceOfDay(dayMs);
      const adjusted = day.balance - extraAvg;
      if (adjusted < 10) {
        const label = new Date(dayMs).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', weekday: 'short' });
        const kinds = db.prepare(`SELECT kind, COUNT(DISTINCT vehicle_id) n FROM vehicle_dispositions
          WHERE starts_at < ? AND ends_at > ? GROUP BY kind`)
          .all(new Date(dayMs + 86_400_000).toISOString(), new Date(dayMs).toISOString());
        const kindMap = Object.fromEntries(kinds.map(row => [row.kind, row.n]));
        alerts.push(`${label}: запас ${Math.round(adjusted)} маш. (сетка ${Math.round(day.need)}, `
          + `занято ${day.busy}, свободно ${day.free}, разовые ~${Math.round(extraAvg)}/день). Рычаги: `
          + `без водителя ${kindMap.no_driver || 0}, пересменок ${kindMap.shift || 0}, ремонтов ${kindMap.repair || 0}`);
      }
    }
    if (alerts.length) {
      const text = `⚖ Узкие дни впереди — парк может не вывезти сетку:\n${alerts.join('\n')}\n`
        + 'Разбор и действия: План парка → клик по строке «Баланс к сетке» нужного дня.';
      notify('logist', text, null, null, { category: 'balance' });
      notify('boss', text, null, null, { category: 'balance' });
      notify('resource', text, null, null, { category: 'balance' });
    }
  } catch (error) {
    console.error('runBalanceWatch:', error.message);
  }
}
setInterval(runBalanceWatch, 30 * 60_000);
setTimeout(runBalanceWatch, 90_000);

function runMissedDepartureWatch() {
  try {
    const rows = db.prepare(`SELECT t.id, t.order_no, t.starts_at, v.plate,
        t.driver_notified_at, t.on_line_at,
        (SELECT name FROM zones WHERE id=t.from_zone_id) fz,
        (SELECT name FROM zones WHERE id=t.to_zone_id) tz,
        (SELECT o.window_to FROM orders o WHERE o.id=t.order_id) window_to
      FROM trips t JOIN vehicles v ON v.id=t.vehicle_id
      WHERE t.status='plan'
        AND datetime(t.starts_at) < datetime('now','-2 hours')
        AND t.driver_notified_at IS NULL`).all();
    if (!rows.length) return;
    const seenRaw = db.prepare(`SELECT value FROM app_meta WHERE key='missed_departure_ids'`).get()?.value;
    const seen = new Set(seenRaw ? JSON.parse(seenRaw) : []);
    const fresh = rows.filter(row => !seen.has(row.id));
    if (!fresh.length) return;
    const msk = mskStamp;
    const lines = fresh.slice(0, 8).map(row =>
      `${row.plate} №${row.order_no || '—'} ${row.fz}→${row.tz} (выход был ${msk(row.starts_at)} МСК` +
      `${row.window_to ? `, окно клиента до ${msk(row.window_to)}` : ''})`);
    const text = `🌙 Рейс не вышел в окно: задание водителю не отправлено, плановый выход прошёл ` +
      `больше 2 часов назад — ${lines.join('; ')}${fresh.length > 8 ? ` и ещё ${fresh.length - 8}` : ''}. ` +
      `Замените ТС или передоговорите окно СЕЙЧАС — утром оно будет сгоревшим`;
    notify('logist', text, null, null, { category: 'missed_departure' });
    notify('dispatcher', text, null, null, { category: 'missed_departure' });
    for (const row of fresh) seen.add(row.id);
    db.prepare(`INSERT INTO app_meta(key,value) VALUES('missed_departure_ids',?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
      .run(JSON.stringify([...seen].slice(-300)));
  } catch (error) {
    console.error('Сторож невыхода в окно:', error.message);
  }
}
setInterval(runMissedDepartureWatch, 20 * 60_000);
setTimeout(runMissedDepartureWatch, 80_000);

function runStaleTransfersWatch() {
  try {
    const stale = db.prepare(`SELECT d.id, d.ends_at, d.purpose, d.note, v.plate,
        (SELECT name FROM addresses WHERE id=d.address_id) to_name
      FROM vehicle_dispositions d JOIN vehicles v ON v.id=d.vehicle_id
      WHERE d.kind='transfer' AND d.arrived_at IS NULL
        AND datetime(d.ends_at) < datetime('now','-6 hours')`).all();
    if (!stale.length) return;
    const toClose = stale.filter(item =>
      Date.now() - Date.parse(item.ends_at) > 24 * 3_600_000);
    for (const item of toClose) {
      db.prepare(`UPDATE vehicle_dispositions SET arrived_at=ends_at,
          note=CASE WHEN note='' THEN 'закрыт автоматически: сутки после планового прибытия без отметок'
            ELSE note || ' · закрыт автоматически' END,
          updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(item.id);
      audit(db, null, 'transfer-autoclose', 'transfer', item.id, { endsAt: item.ends_at }, '');
    }
    const remind = stale.filter(item => !toClose.includes(item));
    if (remind.length) {
      const key = new Date().toISOString().slice(0, 10);
      const done = db.prepare(`SELECT value FROM app_meta WHERE key='stale_transfer_day'`).get()?.value;
      if (done !== key) {
        notify('dispatcher', `🚚 Перегоны без отметок дольше 6 часов после планового прибытия: ` +
          remind.map(item => `${item.plate} → ${(item.to_name || '').slice(0, 30)} (план ${ddmm(item.ends_at)})`).join('; ') +
          `. Отметьте этапы — или через сутки перегон закроется сам плановым временем`, null, null, { category: 'stale_transfers' });
        db.prepare(`INSERT INTO app_meta(key,value) VALUES('stale_transfer_day',?)
          ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key);
      }
    }
    if (toClose.length) console.log(`Перегоны: автозакрыто ${toClose.length} (сутки без отметок)`);
  } catch (error) {
    console.error('Зависшие перегоны:', error.message);
  }
}
setInterval(runStaleTransfersWatch, 30 * 60_000);
setTimeout(runStaleTransfersWatch, 70_000);

function runMorningDirections() {
  try {
    const msk = new Date(Date.now() + 3 * 3_600_000);
    if (msk.getUTCHours() !== 6 || msk.getUTCMinutes() < 55) return;
    const day = msk.toISOString().slice(0, 10);
    if (db.prepare(`SELECT value FROM app_meta WHERE key='morning_directions_day'`).get()?.value === day) return;
    const arrivals = db.prepare(`SELECT z.name zone, COUNT(*) n FROM trips t
      JOIN zones z ON z.id=t.to_zone_id
      WHERE t.status IN ('plan','run') AND datetime(t.ends_at) BETWEEN datetime('now') AND datetime('now','+72 hours')
      GROUP BY z.name`).all();
    const outgoing = db.prepare(`SELECT z.name zone, COUNT(*) n FROM orders o
      JOIN zones z ON z.id=o.from_zone_id
      WHERE o.deleted_at IS NULL AND o.status<>'rejected' AND o.trip_id IS NULL
        AND datetime(o.window_from) BETWEEN datetime('now') AND datetime('now','+96 hours')
      GROUP BY z.name`).all();
    const outMap = Object.fromEntries(outgoing.map(row => [row.zone, row.n]));
    const deficit = arrivals
      .map(row => ({ zone: row.zone, arrive: row.n, out: outMap[row.zone] || 0,
        gap: row.n - (outMap[row.zone] || 0) }))
      .filter(row => row.gap > 0 && row.zone !== 'Дом')
      .sort((a, b) => b.gap - a.gap).slice(0, 5);
    if (!deficit.length) return;
    const lines = deficit.map(row =>
      `${row.zone}: приедут ${row.arrive}, обратных заявок ${row.out} — нужно ещё ${row.gap}`);
    notify('sales', `🧭 Направления дня (72 ч): машины освобождаются там, где нет обратных грузов — ` +
      lines.join('; ') + `. Продаём маршрут целиком, а не одно плечо: заявка из зоны прибытия ` +
      `дороже простоя и порожняка (пороги ставок — в «Конструктор → 📚 Шаблоны кругов»)`, null, null, { category: 'sales_directions' });
    db.prepare(`INSERT INTO app_meta(key,value) VALUES('morning_directions_day',?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(day);
  } catch (error) {
    console.error('Утренние направления:', error.message);
  }
}
setInterval(runMorningDirections, 5 * 60_000);


// ── Стыковка следующего плеча до выгрузки ──
// Машина, выгружающаяся в ближайшие 6 часов без следующего задания, — это
// будущий зазор: в августе машина стояла между рейсами 0,85 дня, каждый час
// зазора по парку — ~100 т₽ маржи. Обратный подбор: не «заявке машину», а
// «машине заявку» — из очереди, с окном от освобождения до +36 часов и
// минимальным подгоном от точки выгрузки. Итог кладётся в те же черновики
// (assign_drafts): у логиста это кнопка «⚡» в карточке заявки.
function runDockingWatch() {
  try {
    const soon = db.prepare(`SELECT t.id, t.vehicle_id, t.ends_at, v.plate,
        (SELECT vt.name FROM vehicle_types vt WHERE vt.id=v.type_id) type_name
      FROM trips t JOIN vehicles v ON v.id=t.vehicle_id
      WHERE t.status='run' AND t.unloaded_at IS NULL
        AND datetime(t.ends_at) < datetime('now', '+6 hours')
        AND NOT EXISTS (SELECT 1 FROM trips n WHERE n.vehicle_id=t.vehicle_id
          AND n.id<>t.id AND n.status IN ('plan','run') AND n.starts_at > t.starts_at)
        AND NOT EXISTS (SELECT 1 FROM vehicle_dispositions d WHERE d.vehicle_id=t.vehicle_id
          AND datetime(d.starts_at) < datetime(t.ends_at, '+12 hours')
          AND datetime(d.ends_at) > datetime(t.ends_at))`).all();
    if (!soon.length) return;
    // Глобальное паросочетание вместо «каждой машине лучшую из оставшихся»:
    // жадность по порядку цикла отдавала первой машине московскую заявку с
    // подгоном 20 км, а последней — огрызок за 685 км (кейс р892ху58 →
    // Пензенская кондитерская). Теперь собираются ВСЕ пары машина×заявка,
    // сортируются по подгону и назначаются от лучших — сумма подгонов
    // минимальна, а пары дальше порога не создаются вовсе.
    const MAX_DOCK_KM = 350;
    const pairs = [];
    for (const trip of soon) {
      const origin = vehiclePositionBefore(trip.vehicle_id,
        new Date(Date.parse(trip.ends_at) + 60_000).toISOString());
      if (!origin || !Number.isFinite(origin.latitude)) continue;
      const orders = db.prepare(`SELECT o.* FROM orders o
        WHERE o.trip_id IS NULL AND o.status='new' AND o.confirmed_at IS NOT NULL
          AND datetime(o.window_to) > datetime(?)
          AND datetime(o.window_from) < datetime(?, '+36 hours')
          AND NOT EXISTS (SELECT 1 FROM vehicle_dispositions x WHERE x.vehicle_id=?
            AND x.kind<>'reserve'
            AND datetime(x.starts_at) < datetime(o.window_to) AND datetime(x.ends_at) > datetime(o.window_from))`)
        .all(trip.ends_at, trip.ends_at, trip.vehicle_id);
      for (const order of orders) {
        if (!bodyTypeMatches(order.body_type, trip.type_name)) continue;
        const target = addressPointById(order.from_address_id) || addressPointByText(order.from_point);
        if (!target) continue;
        const km = roadKm(origin.latitude, origin.longitude, target.latitude, target.longitude);
        if (km > MAX_DOCK_KM) continue;
        pairs.push({ trip, order, km });
      }
    }
    pairs.sort((a, b) => a.km - b.km);
    const usedVehicles = new Set();
    const usedOrders = new Set();
    let made = 0;
    const upsert = db.prepare(`INSERT INTO assign_drafts(order_id,vehicle_id,empty_km,reason,computed_at)
      VALUES(?,?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(order_id) DO UPDATE SET vehicle_id=excluded.vehicle_id,
        empty_km=excluded.empty_km, reason=excluded.reason,
        computed_at=CURRENT_TIMESTAMP, outcome=NULL, resolved_at=NULL
      WHERE assign_drafts.outcome IS NULL AND excluded.empty_km + 20 < assign_drafts.empty_km`);
    for (const pair of pairs) {
      if (usedVehicles.has(pair.trip.vehicle_id) || usedOrders.has(pair.order.id)) continue;
      usedVehicles.add(pair.trip.vehicle_id);
      usedOrders.add(pair.order.id);
      const changed = upsert.run(pair.order.id, pair.trip.vehicle_id, pair.km,
        `стыковка: ${pair.trip.plate} выгружается ${new Date(Date.parse(pair.trip.ends_at) + 3 * 3_600_000)
          .toISOString().slice(11, 16)} МСК, подгон ~${Math.round(pair.km)} км`).changes;
      made += changed;
    }
    // Черновики с подгоном за порогом больше не имеют права висеть: их
    // рекомендации хуже, чем решение логиста по кругам.
    db.prepare(`DELETE FROM assign_drafts WHERE outcome IS NULL AND empty_km > ?
      AND reason LIKE 'стыковка:%'`).run(MAX_DOCK_KM);
    if (made) console.log(`Стыковка плеч: черновики для ${made} освобождающихся машин`);
  } catch (error) {
    console.error('Стыковка плеч:', error.message);
  }
}
setInterval(runDockingWatch, 30 * 60_000);
setTimeout(runDockingWatch, 55_000);

function runAssignDrafts() {
  try {
    // Итоги и очистка — КРУГЛОСУТОЧНО (черновики стыковки создаются и днём):
    // заявка получила рейс — фиксируем accepted/overridden; окно прошло —
    // черновик удаляется. Раньше этот блок жил внутри ночного окна, и
    // дневные исходы ждали ночи.
    db.prepare(`UPDATE assign_drafts SET
        outcome = CASE WHEN (SELECT t.vehicle_id FROM orders o JOIN trips t ON t.id=o.trip_id
          WHERE o.id=assign_drafts.order_id) = assign_drafts.vehicle_id
          THEN 'accepted' ELSE 'overridden' END,
        resolved_at = CURRENT_TIMESTAMP
      WHERE outcome IS NULL AND (SELECT o.trip_id FROM orders o WHERE o.id=assign_drafts.order_id) IS NOT NULL`).run();
    db.prepare(`DELETE FROM assign_drafts WHERE outcome IS NULL AND (SELECT datetime(o.window_from)
      FROM orders o WHERE o.id=assign_drafts.order_id) < datetime('now')`).run();
    // Массовый подбор «заявке машину» — только ночью (20:00–08:00 МСК):
    // днём логисты назначают сами, а стыковку освобождающихся машин ведёт
    // отдельный сторож runDockingWatch.
    const mskHour = new Date(Date.now() + 3 * 3_600_000).getUTCHours();
    if (mskHour >= 8 && mskHour < 20) return;
    const orders = db.prepare(`SELECT * FROM orders
      WHERE trip_id IS NULL AND status='new' AND confirmed_at IS NOT NULL
        AND datetime(window_from) > datetime('now')
        AND datetime(window_from) < datetime('now','+2 days')`).all();
    let made = 0;
    for (const order of orders) {
      const pick = pickVehicleFor(order);
      if (!pick) continue;
      db.prepare(`INSERT INTO assign_drafts(order_id,vehicle_id,empty_km,reason,computed_at)
        VALUES(?,?,?,?,CURRENT_TIMESTAMP)
        ON CONFLICT(order_id) DO UPDATE SET vehicle_id=excluded.vehicle_id,
          empty_km=excluded.empty_km, reason=excluded.reason,
          computed_at=CURRENT_TIMESTAMP, outcome=NULL, resolved_at=NULL`)
        .run(order.id, pick.vehicle.id, pick.km,
          `подгон ~${Math.round(pick.km)} км, свободна на момент погрузки`);
      made += 1;
    }
    if (made) console.log(`Черновики назначений: подобраны машины для ${made} заявок`);
  } catch (error) {
    console.error('Черновики назначений:', error.message);
  }
}
setInterval(runAssignDrafts, 60 * 60_000);
setTimeout(runAssignDrafts, 50_000);

// Автопересев плана вывоза: сетку заполнили из истории один раз и забыли —
// через месяц она врёт. Раз в неделю (в ночь на понедельник) пересеваем из
// свежей истории; плечи, правленные вручную (manual=1), не трогаем.
function runDeliverySeedWatch() {
  try {
    const mskNow = new Date(Date.now() + 3 * 3_600_000);
    if (mskNow.getUTCDay() !== 1 || mskNow.getUTCHours() !== 4) return;
    const day = mskNow.toISOString().slice(0, 10);
    const doneKey = db.prepare(`SELECT value FROM app_meta WHERE key='delivery_seed_day'`).get()?.value;
    if (doneKey === day) return;
    const created = seedDeliverySlots(db, null);
    db.prepare(`INSERT INTO app_meta(key,value) VALUES('delivery_seed_day',?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(day);
    console.log(`План вывоза: сетка пересеяна из истории, слотов ${created}`);
  } catch (error) {
    console.error('Автопересев плана вывоза:', error.message);
  }
}
setInterval(runDeliverySeedWatch, 30 * 60_000);

function runEmptyKmWatch() {
  try {
    const vehicles = db.prepare(`SELECT DISTINCT vehicle_id FROM trips
      WHERE status IN ('plan','run') AND datetime(starts_at) > datetime('now')`).all();
    let total = 0;
    for (const row of vehicles) total += refreshEmptyKm(row.vehicle_id);
    if (total) console.log(`Сторож порожняка: пересчитан подгон у ${total} рейсов`);
  } catch (error) {
    console.error('Сторож порожняка:', error.message);
  }
}
setInterval(runEmptyKmWatch, 6 * 3_600_000);
setTimeout(runEmptyKmWatch, 40_000);

function runNextTripWatch() {
  try {
    // Горизонт 6 часов: за 2 часа груз уже не найти — сигнал приходил,
    // когда зазор было не спасти. Теперь сторож стыковки успевает подобрать
    // черновик, и в уведомлении сразу есть рекомендация.
    const rows = tripsWithoutNext(db, Date.now(), 6 * 3_600_000, true);
    if (!rows.length) return;
    const fmt = iso => new Date(Date.parse(iso) + 3 * 3_600_000).toISOString().slice(11, 16);
    const draftFor = db.prepare(`SELECT d.empty_km, o.order_no FROM assign_drafts d
      JOIN orders o ON o.id=d.order_id WHERE d.vehicle_id=? AND d.outcome IS NULL LIMIT 1`);
    const lines = rows.slice(0, 12).map(trip => {
      const draft = draftFor.get(trip.vehicle_id);
      return `${trip.plate} → ${trip.to_point || trip.to_name || '—'}` +
        ` (выгрузка ${fmt(trip.ends_at)} МСК${Date.parse(trip.ends_at) < Date.now() ? ', время вышло' : ''}` +
        `${draft ? `; ⚡ подобрана заявка №${draft.order_no}, подгон ~${Math.round(draft.empty_km || 0)} км` : ''})`;
    });
    notify('logist', `⏭ Следующий рейс не назначен — выгрузка в ближайшие 6 часов: ${lines.join('; ')}` +
      `${rows.length > 12 ? ` и ещё ${rows.length - 12}` : ''}. Заявки с «⚡» назначаются одним нажатием в очереди («Логист»)`, null, null, { category: 'no_next' });
    const stamp = db.prepare('UPDATE trips SET next_alert_at=CURRENT_TIMESTAMP WHERE id=?');
    for (const trip of rows) stamp.run(trip.id);
  } catch (error) {
    console.error('Сигнал «следующий рейс не назначен»:', error.message);
  }
}
setInterval(runNextTripWatch, 10 * 60_000);
setTimeout(runNextTripWatch, 65_000);

// Координаты пункта по тексту: точное имя адреса, затем начало, затем
// подстрока (пункты 1С — свободный текст, имена зон — алиасы справочника).
function addressPointByText(text) {
  const needle = String(text || '').trim();
  if (needle.length < 2) return null;
  // Имя геозоны — координаты её центра (иначе «Дом» находил бы Домодедово).
  return db.prepare(`SELECT latitude,longitude FROM zones
      WHERE name=? COLLATE NOCASE AND latitude IS NOT NULL`).get(needle)
    || db.prepare(`SELECT latitude,longitude FROM addresses
      WHERE name=? COLLATE NOCASE AND latitude IS NOT NULL LIMIT 1`).get(needle)
    || db.prepare(`SELECT latitude,longitude FROM addresses
      WHERE name LIKE ? AND latitude IS NOT NULL LIMIT 1`).get(`${needle}%`)
    || db.prepare(`SELECT latitude,longitude FROM addresses
      WHERE name LIKE ? AND latitude IS NOT NULL LIMIT 1`).get(`%${needle}%`)
    || null;
}
// function-объявление (hoisting): emptyKmFor вызывается из PATCH-ветки
// рейсов, которая в коде стоит ВЫШЕ, — стрелка в const давала TDZ и
// замена ТС падала 500 «Cannot access before initialization».
function addressPointById(id) {
  return id
    ? db.prepare(`SELECT latitude,longitude FROM addresses
        WHERE id=? AND latitude IS NOT NULL`).get(id) || null
    : null;
}

// Позиция сцепки перед моментом: точка выгрузки последнего рейса ЛИБО
// место ремонта, если ремонт с адресом был позже выгрузки.
function vehiclePositionBefore(vehicleId, beforeIso, excludeTripId = '') {
  const prevTrip = db.prepare(`SELECT t.to_point, z.name to_zone_name, t.ends_at
    FROM trips t JOIN zones z ON z.id=t.to_zone_id
    WHERE t.vehicle_id=? AND t.status<>'rejected' AND t.id<>? AND t.starts_at<?
    ORDER BY t.ends_at DESC LIMIT 1`).get(vehicleId, excludeTripId, beforeIso);
  // Ремонт с адресом и ЗАВЕРШЁННЫЙ перегон тоже задают место сцепки:
  // после перегона машина стоит в точке прибытия, а не там, где выгрузилась.
  const prevPlace = db.prepare(`SELECT COALESCE(d.arrived_at,d.ends_at) at, a.latitude, a.longitude
    FROM vehicle_dispositions d JOIN addresses a ON a.id=d.address_id
    WHERE d.vehicle_id=? AND a.latitude IS NOT NULL AND d.starts_at<?
      AND (d.kind='repair' OR (d.kind='transfer' AND d.arrived_at IS NOT NULL))
    ORDER BY at DESC LIMIT 1`).get(vehicleId, beforeIso);
  if (prevPlace && (!prevTrip || String(prevPlace.at) >= String(prevTrip.ends_at))) {
    return { latitude: prevPlace.latitude, longitude: prevPlace.longitude };
  }
  if (prevTrip) return addressPointByText(prevTrip.to_point || prevTrip.to_zone_name);
  return null;
}

// Обрезка строк из формы. Именно function-объявление: стрелка в const
// давала TDZ — обработчики выше по файлу выполняются раньше объявления
// (та же ловушка, что с addressPointById в 8dd9c1f).
function clean(value) { return String(value || '').trim(); }

// Контакты дежурных сотрудников для водителя: механик, начальник колонны,
// диспетчер, логист. Берём тех, у кого заполнен телефон, — пустые карточки
// в ответе водителю бесполезны.
function employeeContacts() {
  return db.prepare(`SELECT full_name, job_role, role, phone FROM users
    WHERE deleted_at IS NULL AND active=1 AND phone<>''
    ORDER BY job_role, full_name`).all();
}

// Где сцепка стоит словами (для карточки задания и списков): точка
// прибытия завершённого перегона, иначе выгрузка последнего рейса.
function vehiclePlaceText(vehicleId, beforeIso = new Date().toISOString()) {
  // Только УЖЕ НАЧАВШИЕСЯ рейсы: назначенный на послезавтра рейс не
  // говорит о том, где машина стоит сейчас (иначе перегон, завершённый
  // сегодня, проигрывал будущему рейсу и место показывалось старое).
  const trip = db.prepare(`SELECT t.to_point, z.name to_zone_name, t.ends_at FROM trips t
    JOIN zones z ON z.id=t.to_zone_id WHERE t.vehicle_id=? AND t.status<>'rejected'
      AND t.starts_at<? ORDER BY t.ends_at DESC LIMIT 1`).get(vehicleId, beforeIso);
  const transfer = db.prepare(`SELECT a.name, d.arrived_at FROM vehicle_dispositions d
    JOIN addresses a ON a.id=d.address_id
    WHERE d.vehicle_id=? AND d.kind='transfer' AND d.arrived_at IS NOT NULL AND d.arrived_at<=?
    ORDER BY d.arrived_at DESC LIMIT 1`).get(vehicleId, beforeIso);
  if (transfer && (!trip || String(transfer.arrived_at) >= String(trip.ends_at))) return transfer.name;
  return trip ? (trip.to_point || trip.to_zone_name) : '';
}

// Порожний подгон: от позиции сцепки до пункта погрузки (адрес заявки
// приоритетнее текста). null — пункт не распознан, а не ноль.
function emptyKmFor(vehicleId, startsAtIso, fromAddressId, fromText, excludeTripId = '') {
  const origin = vehiclePositionBefore(vehicleId, startsAtIso, excludeTripId);
  const target = addressPointById(fromAddressId) || addressPointByText(fromText);
  if (!origin || !target) return null;
  return roadKm(origin.latitude, origin.longitude, target.latitude, target.longitude);
}

// Порожний подгон стареет: его считают один раз при назначении, а цепочка
// потом меняется — вставили рейс между, прибыл перегон, сдвинули время. Так
// у р459ху58 подгон 229 км от Саратова остался в рейсе после того, как
// перегон уже привёз машину в Пензу: те же километры считались дважды.
// Поэтому после каждого события, меняющего цепочку, пересчитываем подгон
// у ещё не начавшихся рейсов сцепки. Начавшиеся не трогаем: подгон уже
// совершён, это факт.
function refreshEmptyKm(vehicleId) {
  if (!vehicleId) return 0;
  const trips = db.prepare(`SELECT t.id,t.starts_at,t.from_point,t.empty_km,o.from_address_id
    FROM trips t LEFT JOIN orders o ON o.id=t.order_id
    WHERE t.vehicle_id=? AND t.status IN ('plan','run')
      AND datetime(t.starts_at) > datetime('now')`).all(vehicleId);
  let changed = 0;
  for (const trip of trips) {
    const km = emptyKmFor(vehicleId, trip.starts_at, trip.from_address_id, trip.from_point, trip.id);
    if (km == null) continue;
    const current = Number(trip.empty_km);
    if (Number.isFinite(current) && Math.abs(current - km) <= 1) continue;
    db.prepare('UPDATE trips SET empty_km=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(km, trip.id);
    changed += 1;
  }
  return changed;
}

function normalizeTrip(body) {
  for (const key of ['vehicleId', 'fromZoneId', 'toZoneId', 'startsAt', 'endsAt']) {
    if (!body[key]) throw Object.assign(new Error(`Поле ${key} обязательно`), { status: 422 });
  }
  const startsAt = Date.parse(body.startsAt);
  const endsAt = Date.parse(body.endsAt);
  if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt)) {
    throw Object.assign(new Error('Некорректные даты рейса'), { status: 422 });
  }
  if (endsAt <= startsAt) {
    throw Object.assign(new Error('Окончание рейса должно быть позже начала'), { status: 422 });
  }
  return {
    vehicleId: body.vehicleId, orderId: body.orderId || null,
    customerName: String(body.customerName || '').trim(),
    fromZoneId: body.fromZoneId, toZoneId: body.toZoneId,
    fromPoint: String(body.fromPoint || '').trim(), toPoint: String(body.toPoint || '').trim(),
    startsAt: new Date(startsAt).toISOString(), endsAt: new Date(endsAt).toISOString(),
    distanceKm: Number(body.distanceKm || 0), revenueVat: Number(body.revenueVat || 0),
    status: body.status || 'plan', rejectionReason: body.rejectionReason || null,
    temperatureMode: String(body.temperatureMode || ''),
    bodyType: String(body.bodyType || '')
  };
}

async function api(request, response, url) {
  if (!mutationOriginAllowed(request)) return errorJson(response, 403, 'Недопустимый Origin');
  const pathname = url.pathname;

  if (request.method === 'POST' && pathname === '/api/auth/login') {
    const body = await readJson(request);
    const attemptKey = `${requestIp(request)}:${String(body.username || '').toLowerCase()}`;
    const recentAttempts = (loginAttempts.get(attemptKey) || []).filter(time => Date.now() - time < 15 * 60_000);
    if (recentAttempts.length >= 10) return errorJson(response, 429, 'Слишком много попыток. Повторите позже');
    const user = db.prepare('SELECT * FROM users WHERE username=? COLLATE NOCASE').get(String(body.username || '').trim());
    if (!user || !user.active || !verifyPassword(String(body.password || ''), user.password_hash)) {
      recentAttempts.push(Date.now());
      loginAttempts.set(attemptKey, recentAttempts);
      audit(db, user, 'login_failed', 'session', null, {}, requestIp(request));
      return errorJson(response, 401, 'Неверный логин или пароль');
    }
    loginAttempts.delete(attemptKey);
    const token = newSessionToken();
    const expires = new Date(Date.now() + config.sessionTtlMs).toISOString();
    db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)')
      .run(tokenHash(token), user.id, expires);
    audit(db, user, 'login', 'session', null, {}, requestIp(request));
    return json(response, 200, { user: publicUser(user) }, {
      'Set-Cookie': `planner_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(config.sessionTtlMs / 1000)}${config.secureCookies ? '; Secure' : ''}`
    });
  }

  if (request.method === 'POST' && pathname === '/api/auth/logout') {
    const token = parseCookies(request.headers.cookie).planner_session;
    const user = currentUser(request);
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(tokenHash(token));
    audit(db, user, 'logout', 'session');
    return json(response, 200, { ok: true }, {
      'Set-Cookie': 'planner_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'
    });
  }

  if (request.method === 'GET' && pathname === '/api/auth/me') {
    const user = requireUser(request, response);
    return user && json(response, 200, { user: publicUser(user) });
  }

  if (request.method === 'GET' && pathname === '/api/health') {
    return json(response, 200, {
      ok: true, database: Boolean(db.prepare('SELECT 1 AS ok').get().ok),
      assetVersion: ASSET_VERSION
    });
  }

  // Геокодинг из открытых источников (OSM Nominatim): подсказки адреса
  // и координат для справочника. Лимит источника ~1 запрос/сек.
  if (request.method === 'GET' && pathname === '/api/geocode') {
    const user = requirePermission(request, response, 'orders:write');
    if (!user) return;
    const query = String(url.searchParams.get('q') || '').trim();
    if (query.length < 3) return errorJson(response, 422, 'Уточните запрос (от 3 символов)');
    try {
      return json(response, 200, { items: await geocodeQuery(query) });
    } catch (error) {
      return errorJson(response, 502,
        error.name === 'TimeoutError' ? 'Геокодинг не ответил — попробуйте ещё раз' : 'Ошибка геокодинга');
    }
  }

  if (request.method === 'GET' && pathname === '/api/bootstrap') {
    const user = requireUser(request, response);
    if (!user) return;
    return json(response, 200, {
      user: publicUser(user), settings: plannerSettings(), reference: allReferenceData(),
      vehicles: listVehicles(), trips: listTrips(url.searchParams.get('date') || ''),
      orders: listOrders(), dispositions: listDispositions(),
      drivers: db.prepare(`SELECT d.*,v.plate vehicle_plate FROM drivers d
        LEFT JOIN vehicles v ON v.id=d.vehicle_id
        WHERE d.status<>'fired' ORDER BY d.full_name`).all(),
      revenuePlans: db.prepare('SELECT * FROM revenue_plans ORDER BY period_start').all(),
      driverAssignments: db.prepare(`SELECT a.*,d.full_name driver_name,v.plate vehicle_plate
        FROM driver_assignments a
        JOIN drivers d ON d.id=a.driver_id JOIN vehicles v ON v.id=a.vehicle_id
        WHERE a.ends_at > datetime('now','-30 days') ORDER BY a.starts_at`).all(),
      orderFiles: db.prepare(`SELECT f.id,f.order_id,f.file_name,f.mime,f.size,f.uploaded_at,
          u.full_name uploaded_by
        FROM order_files f LEFT JOIN users u ON u.id=f.uploaded_by
        JOIN orders o ON o.id=f.order_id AND o.deleted_at IS NULL
        ORDER BY f.uploaded_at`).all(),
      routeSpots: db.prepare(`SELECT s.* FROM route_spots s JOIN routes r ON r.id=s.route_id
        WHERE r.status IN ('draft','handed','assigned') ORDER BY s.seq`).all(),
      routes: db.prepare(`SELECT r.*,v.plate vehicle_plate FROM routes r
        LEFT JOIN vehicles v ON v.id=r.vehicle_id
        WHERE r.status IN ('draft','handed','assigned')
        ORDER BY r.created_at DESC`).all(),
      demurrage: demurrageSummary(db),
      customerDates: upcomingCustomerDates(db, Date.now(), 7),
      vehicleHolds: db.prepare(`SELECT h.vehicle_id, h.until, h.note, h.held_by_name
        FROM vehicle_holds h WHERE datetime(h.until) > datetime('now')`).all(),
      boardNotes: activeBoardNotes(),
      driverRatings: driverRatings(db),
      attendanceLastDay: db.prepare('SELECT MAX(day) d FROM driver_attendance').get().d,
      // Черновики ночного подбора: утром логист подтверждает одним кликом.
      assignDrafts: db.prepare(`SELECT d.order_id, d.vehicle_id, d.empty_km, d.reason,
          d.computed_at, v.plate vehicle_plate
        FROM assign_drafts d JOIN vehicles v ON v.id=d.vehicle_id
        JOIN orders o ON o.id=d.order_id
        WHERE d.outcome IS NULL AND o.trip_id IS NULL`).all(),
      // Закрепление машин по кругам («План парка»): «Потоки» помечают
      // кандидатов чужого направления бейджем круга.
      roundPlans: db.prepare('SELECT vehicle_id, round_key FROM vehicle_round_plans').all()
    });
  }

  // ── CRM-карточка клиента: сводка, контакты, журнал, реквизиты ──
  if (request.method === 'GET' && pathname === '/api/customers/card') {
    const user = requirePermission(request, response, 'planner:read');
    if (!user) return;
    const name = String(url.searchParams.get('name') || '').trim();
    if (!name) return errorJson(response, 422, 'Нужно имя клиента');
    return json(response, 200, {
      ...customerCard(db, name),
      managers: db.prepare(`SELECT id, full_name FROM users
        WHERE active=1 AND deleted_at IS NULL ORDER BY full_name`).all()
    });
  }
  if (request.method === 'PUT' && pathname === '/api/customers/profile') {
    const user = requirePermission(request, response, 'orders:write');
    if (!user) return;
    const body = await readJson(request);
    const name = String(body.name || '').trim();
    if (!name) return errorJson(response, 422, 'Нужно имя клиента');
    const status = ['active', 'prospect', 'sleeping', 'lost'].includes(body.status) ? body.status : 'active';
    db.prepare(`INSERT INTO customer_profiles(customer_name,inn,segment,status,manager_id,contract_no,
        contract_until,payment_days,conditions,next_contact_at,tags,updated_by)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(customer_name) DO UPDATE SET inn=excluded.inn, segment=excluded.segment,
        status=excluded.status, manager_id=excluded.manager_id, contract_no=excluded.contract_no,
        contract_until=excluded.contract_until, payment_days=excluded.payment_days,
        conditions=excluded.conditions, next_contact_at=excluded.next_contact_at, tags=excluded.tags,
        updated_by=excluded.updated_by, updated_at=CURRENT_TIMESTAMP`)
      .run(name, String(body.inn || '').trim().slice(0, 20), String(body.segment || '').trim().slice(0, 2),
        status, body.managerId || null, String(body.contractNo || '').trim().slice(0, 60),
        body.contractUntil || null,
        Number.isFinite(Number(body.paymentDays)) && body.paymentDays !== '' && body.paymentDays !== null
          ? Number(body.paymentDays) : null,
        String(body.conditions || '').trim().slice(0, 1000), body.nextContactAt || null,
        String(body.tags || '').trim().slice(0, 200), user.id);
    audit(db, user, 'update', 'customer-profile', name, { status, segment: body.segment });
    return json(response, 200, { ok: true });
  }
  if (request.method === 'POST' && pathname === '/api/customers/contacts') {
    const user = requirePermission(request, response, 'orders:write');
    if (!user) return;
    const body = await readJson(request);
    const name = String(body.customerName || '').trim();
    const fullName = String(body.fullName || '').trim();
    if (!name || !fullName) return errorJson(response, 422, 'Нужны клиент и ФИО контакта');
    const birthday = String(body.birthday || '').trim();
    if (birthday && !/^(\d{4}-)?\d{2}-\d{2}$/.test(birthday)) {
      return errorJson(response, 422, 'День рождения: ГГГГ-ММ-ДД или ММ-ДД');
    }
    const id = randomUUID();
    db.prepare(`INSERT INTO customer_contacts(id,customer_name,full_name,position,phone,email,birthday,note)
      VALUES(?,?,?,?,?,?,?,?)`).run(id, name, fullName.slice(0, 120),
      String(body.position || '').trim().slice(0, 120), String(body.phone || '').trim().slice(0, 40),
      String(body.email || '').trim().slice(0, 120), birthday || null,
      String(body.note || '').trim().slice(0, 500));
    audit(db, user, 'create', 'customer-contact', id, { customer: name, fullName });
    return json(response, 201, { id });
  }
  const contactMatch = route(/^\/api\/customers\/contacts\/([^/]+)$/, pathname);
  if (contactMatch && request.method === 'DELETE') {
    const user = requirePermission(request, response, 'orders:write');
    if (!user) return;
    const contact = db.prepare('SELECT * FROM customer_contacts WHERE id=?').get(contactMatch[0]);
    if (!contact) return errorJson(response, 404, 'Контакт не найден');
    db.prepare('DELETE FROM customer_contacts WHERE id=?').run(contactMatch[0]);
    audit(db, user, 'delete', 'customer-contact', contactMatch[0], { customer: contact.customer_name, fullName: contact.full_name });
    return json(response, 200, { ok: true });
  }
  if (request.method === 'POST' && pathname === '/api/customers/notes') {
    const user = requirePermission(request, response, 'orders:write');
    if (!user) return;
    const body = await readJson(request);
    const name = String(body.customerName || '').trim();
    const text = String(body.text || '').trim().slice(0, 1000);
    const kind = ['note', 'call', 'meeting', 'email', 'congrats', 'claim'].includes(body.kind) ? body.kind : 'note';
    if (!name || !text) return errorJson(response, 422, 'Нужны клиент и текст');
    const id = randomUUID();
    db.prepare(`INSERT INTO customer_notes(id,customer_name,kind,text,author_id,author_name)
      VALUES(?,?,?,?,?,?)`).run(id, name, kind, text, user.id, user.full_name || user.username);
    return json(response, 201, { id });
  }
  const noteMatch = route(/^\/api\/customers\/notes\/([^/]+)$/, pathname);
  if (noteMatch && request.method === 'DELETE') {
    const user = requirePermission(request, response, 'orders:write');
    if (!user) return;
    const note = db.prepare('SELECT * FROM customer_notes WHERE id=?').get(noteMatch[0]);
    if (!note) return errorJson(response, 404, 'Запись не найдена');
    if (note.author_id !== user.id && !rolesOf(user).includes('admin')) {
      return errorJson(response, 403, 'Удалить запись может её автор или администратор');
    }
    db.prepare('DELETE FROM customer_notes WHERE id=?').run(noteMatch[0]);
    return json(response, 200, { ok: true });
  }

  // ── Простой под погрузкой/выгрузкой: случаи и история претензий ──
  if (request.method === 'GET' && pathname === '/api/demurrage') {
    const user = requirePermission(request, response, 'planner:read');
    if (!user) return;
    return json(response, 200, {
      settings: demurrageSettings(db),
      cases: demurrageCases(db),
      claims: db.prepare(`SELECT * FROM demurrage_claims
        ORDER BY status='new' DESC, created_at DESC LIMIT 300`).all()
    });
  }
  // ── Отчёт за смену: операции сотрудников по именам, время обработки,
  // очереди каскада на начало и конец смены (12 ч: 08–20 и 20–08 МСК) ──
  if (request.method === 'GET' && pathname === '/api/shift-report') {
    const user = requirePermission(request, response, 'reports:read');
    if (!user) return;
    const fallback = currentShift();
    const day = /^\d{4}-\d{2}-\d{2}$/.test(String(url.searchParams.get('day')))
      ? url.searchParams.get('day') : fallback.day;
    const kind = ['day', 'night'].includes(url.searchParams.get('shift'))
      ? url.searchParams.get('shift') : fallback.kind;
    return json(response, 200, shiftReport(db, day, kind));
  }

  // ── «Моя смена»: личная сводка сотрудника для мотивационной плашки ──
  if (request.method === 'GET' && pathname === '/api/my-shift') {
    const user = requireUser(request, response);
    if (!user) return;
    return json(response, 200, myShiftStats(db, user));
  }

  // ── Бронь ТС: «предварительно назначена в голове логиста» — держит машину
  // от продажи под чужую сделку. Переключатель: повторный запрос владельца
  // брони снимает её; чужую бронь снимает только админ. ──
  if (request.method === 'POST' && pathname === '/api/vehicle-holds') {
    const actor = currentUser(request);
    const permission = hasPermission(actor, 'trips:write') ? 'trips:write' : 'orders:write';
    const user = requirePermission(request, response, permission);
    if (!user) return;
    const body = await readJson(request);
    const vehicle = db.prepare(`SELECT id, plate FROM vehicles WHERE id=?`).get(String(body.vehicleId || ''));
    if (!vehicle) return errorJson(response, 404, 'ТС не найдено');
    const existing = db.prepare(`SELECT * FROM vehicle_holds
      WHERE vehicle_id=? AND datetime(until) > datetime('now')`)
      .get(vehicle.id);
    if (body.remove || (existing && !body.note && !body.hours)) {
      if (existing && existing.held_by !== user.id &&
          !(rolesOf(user).includes('admin'))) {
        return errorJson(response, 403, `Бронь поставил ${existing.held_by_name || 'другой сотрудник'} — снять может он или админ`);
      }
      db.prepare('DELETE FROM vehicle_holds WHERE vehicle_id=?').run(vehicle.id);
      audit(db, user, 'hold-remove', 'vehicle', vehicle.id, {}, requestIp(request));
      return json(response, 200, { held: false });
    }
    const hours = Math.min(72, Math.max(1, Number(body.hours) || 24));
    const until = new Date(Date.now() + hours * 3_600_000).toISOString();
    db.prepare(`INSERT INTO vehicle_holds(vehicle_id,until,note,held_by,held_by_name)
      VALUES(?,?,?,?,?)
      ON CONFLICT(vehicle_id) DO UPDATE SET until=excluded.until, note=excluded.note,
        held_by=excluded.held_by, held_by_name=excluded.held_by_name, created_at=CURRENT_TIMESTAMP`)
      .run(vehicle.id, until, String(body.note || '').trim().slice(0, 120),
        user.id, user.full_name || user.username || '');
    invalidateDraftsForVehicle(vehicle.id);
    audit(db, user, 'hold', 'vehicle', vehicle.id, { hours, note: body.note }, requestIp(request));
    return json(response, 200, { held: true, until });
  }

  // ── Объявления на табло: список, публикация, снятие ──
  // Читать может любой сотрудник (объявление и так висит на общем экране),
  // публиковать и снимать — только админ: табло видят все, и случайная
  // надпись на нём дороже, чем лишнее согласование.
  if (request.method === 'GET' && pathname === '/api/board-notes') {
    const user = requirePermission(request, response, 'planner:read');
    if (!user) return;
    const history = hasPermission(user, 'settings:write') && url.searchParams.get('history') === '1';
    return json(response, 200, {
      notes: activeBoardNotes(),
      history: history ? db.prepare(`SELECT id,text,kind,ends_at,created_by_name,created_at,
        removed_at,removed_by_name FROM board_notes ORDER BY created_at DESC LIMIT 30`).all() : []
    });
  }

  if (request.method === 'POST' && pathname === '/api/board-notes') {
    const user = requirePermission(request, response, 'settings:write');
    if (!user) return;
    const body = await readJson(request);
    const text = clean(body.text).slice(0, 240);
    if (!text) return errorJson(response, 422, 'Нужен текст объявления');
    const kind = ['info', 'warn', 'urgent'].includes(body.kind) ? body.kind : 'info';
    // hours = 0 означает «до отмены»: снимать будет админ руками.
    const hours = Number(body.hours);
    const endsAt = Number.isFinite(hours) && hours > 0
      ? new Date(Date.now() + Math.min(720, hours) * 3_600_000).toISOString() : null;
    const id = randomUUID();
    db.prepare(`INSERT INTO board_notes(id,text,subtext,kind,ends_at,created_by,created_by_name)
      VALUES(?,?,?,?,?,?,?)`).run(id, text, clean(body.subtext).slice(0, 160), kind, endsAt,
      user.id, user.full_name || user.username || '');
    audit(db, user, 'board-note', 'board', id, { kind, hours: hours || 0 }, requestIp(request));
    return json(response, 201, { id, notes: activeBoardNotes() });
  }

  if (request.method === 'DELETE' && pathname.startsWith('/api/board-notes/')) {
    const user = requirePermission(request, response, 'settings:write');
    if (!user) return;
    const id = pathname.split('/').pop();
    const note = db.prepare('SELECT id FROM board_notes WHERE id=? AND removed_at IS NULL').get(id);
    if (!note) return errorJson(response, 404, 'Объявление не найдено');
    db.prepare(`UPDATE board_notes SET removed_at=CURRENT_TIMESTAMP, removed_by_name=? WHERE id=?`)
      .run(user.full_name || user.username || '', id);
    audit(db, user, 'board-note-remove', 'board', id, {}, requestIp(request));
    return json(response, 200, { notes: activeBoardNotes() });
  }

  // ── План вывоза грузов от клиентов: сетка слотов, план-факт месяца ──
  if (request.method === 'GET' && pathname === '/api/delivery-plan') {
    const user = requirePermission(request, response, 'planner:read');
    if (!user) return;
    const month = /^\d{4}-\d{2}$/.test(String(url.searchParams.get('month')))
      ? url.searchParams.get('month')
      : new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 7);
    return json(response, 200, deliveryPlan(db, month));
  }
  // Заполнение сетки из истории (регулярные плечи за 60 суток).
  if (request.method === 'POST' && pathname === '/api/delivery-plan/seed') {
    const actor = currentUser(request);
    const permission = hasPermission(actor, 'orders:write') ? 'orders:write' : 'shifts:write';
    const user = requirePermission(request, response, permission);
    if (!user) return;
    const created = seedDeliverySlots(db, user.id);
    audit(db, user, 'seed', 'delivery-plan', null, { created }, requestIp(request));
    return json(response, 200, { created });
  }
  // Правка слота: perDay=0 удаляет, иначе upsert.
  if (request.method === 'POST' && pathname === '/api/delivery-plan/slot') {
    const actor = currentUser(request);
    const permission = hasPermission(actor, 'orders:write') ? 'orders:write' : 'shifts:write';
    const user = requirePermission(request, response, permission);
    if (!user) return;
    const body = await readJson(request);
    const customer = String(body.customer || '').trim();
    const weekday = Number(body.weekday);
    const fromZone = db.prepare('SELECT id FROM zones WHERE id=?').get(String(body.fromZoneId || ''));
    const toZone = db.prepare('SELECT id FROM zones WHERE id=?').get(String(body.toZoneId || ''));
    if (!customer || !fromZone || !toZone || !Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
      return errorJson(response, 422, 'Нужны customer, fromZoneId, toZoneId и weekday (0–6)');
    }
    const perDay = Math.max(0, Number(body.perDay) || 0);
    if (!perDay) {
      db.prepare(`DELETE FROM delivery_slots WHERE customer_name=? AND from_zone_id=? AND to_zone_id=? AND weekday=?`)
        .run(customer, fromZone.id, toZone.id, weekday);
    } else {
      // manual=1: правка руками — автопересев это плечо больше не трогает.
      db.prepare(`INSERT INTO delivery_slots(id,customer_name,from_zone_id,to_zone_id,weekday,per_day,rate,transit_hours,updated_by,manual)
        VALUES(?,?,?,?,?,?,?,?,?,1)
        ON CONFLICT(customer_name,from_zone_id,to_zone_id,weekday) DO UPDATE SET manual=1,
          per_day=excluded.per_day, rate=excluded.rate,
          updated_by=excluded.updated_by, updated_at=CURRENT_TIMESTAMP`)
        .run(randomUUID(), customer, fromZone.id, toZone.id, weekday, perDay,
          Math.max(0, Number(body.rate) || 0), Math.max(1, Number(body.transitHours) || 24), user.id);
    }
    audit(db, user, 'slot', 'delivery-plan', null,
      { customer, weekday, perDay }, requestIp(request));
    return json(response, 200, { ok: true });
  }

  // ── График смен сотрудников: план-факт по людям в отчёте смены ──
  if (request.method === 'GET' && pathname === '/api/staff-shifts') {
    const user = requirePermission(request, response, 'reports:read');
    if (!user) return;
    const from = String(url.searchParams.get('from') || '').slice(0, 10);
    const to = String(url.searchParams.get('to') || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return errorJson(response, 422, 'Нужен период from/to (ГГГГ-ММ-ДД)');
    }
    return json(response, 200, {
      items: db.prepare(`SELECT s.id, s.user_id, s.day, s.kind
        FROM staff_shifts s JOIN users u ON u.id=s.user_id
        WHERE s.day>=? AND s.day<=? AND u.active=1 AND u.deleted_at IS NULL`).all(from, to),
      staff: db.prepare(`SELECT id, full_name, job_role, role FROM users
        WHERE active=1 AND deleted_at IS NULL ORDER BY full_name`).all()
    });
  }
  // Переключатель назначения: есть → снять, нет → поставить.
  if (request.method === 'POST' && pathname === '/api/staff-shifts') {
    const user = requirePermission(request, response, 'shifts:write');
    if (!user) return;
    const body = await readJson(request);
    const day = String(body.day || '').slice(0, 10);
    const kind = ['day', 'night'].includes(body.kind) ? body.kind : null;
    const target = db.prepare(`SELECT id FROM users WHERE id=? AND active=1 AND deleted_at IS NULL`)
      .get(String(body.userId || ''));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !kind || !target) {
      return errorJson(response, 422, 'Нужны userId, day (ГГГГ-ММ-ДД) и kind (day|night)');
    }
    const existing = db.prepare(`SELECT id FROM staff_shifts WHERE user_id=? AND day=? AND kind=?`)
      .get(target.id, day, kind);
    if (existing) {
      db.prepare('DELETE FROM staff_shifts WHERE id=?').run(existing.id);
      audit(db, user, 'shift-unassign', 'user', target.id, { day, kind }, requestIp(request));
      return json(response, 200, { assigned: false });
    }
    db.prepare(`INSERT INTO staff_shifts(id,user_id,day,kind,created_by) VALUES(?,?,?,?,?)`)
      .run(randomUUID(), target.id, day, kind, user.id);
    audit(db, user, 'shift-assign', 'user', target.id, { day, kind }, requestIp(request));
    return json(response, 200, { assigned: true });
  }

  // ── Сверка с 1С: история снимков (сам разбор xlsx идёт в браузере,
  // сервер хранит только итоговые сводки для сравнения по месяцам) ──
  if (request.method === 'GET' && pathname === '/api/reconciliation') {
    const user = requirePermission(request, response, 'reports:read');
    if (!user) return;
    return json(response, 200, {
      items: db.prepare(`SELECT r.*, u.full_name created_by_name
        FROM reconciliation_snapshots r LEFT JOIN users u ON u.id=r.created_by
        ORDER BY r.created_at DESC LIMIT 24`).all()
    });
  }
  if (request.method === 'POST' && pathname === '/api/reconciliation') {
    const user = requirePermission(request, response, 'reports:read');
    if (!user) return;
    if (Number(user.guest)) return errorJson(response, 403, 'Гостевой доступ — только просмотр');
    const body = await readJson(request);
    const month = String(body.month || '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) return errorJson(response, 422, 'Некорректный месяц сверки');
    const id = randomUUID();
    db.prepare(`INSERT INTO reconciliation_snapshots(id,month,file_name,summary_json,created_by)
      VALUES(?,?,?,?,?)`).run(id, month,
      String(body.fileName || '').slice(0, 200),
      JSON.stringify(body.summary || {}), user.id);
    audit(db, user, 'create', 'reconciliation', id, { month }, requestIp(request));
    return json(response, 201, { id });
  }

  // Статус претензии: new (к выставлению) → billed (выставлена) / cancelled.
  if (request.method === 'PATCH' && pathname.startsWith('/api/demurrage/')) {
    const user = requirePermission(request, response, 'orders:write');
    if (!user) return;
    const id = pathname.split('/')[3];
    const body = await readJson(request);
    const status = String(body.status || '');
    if (!['new', 'billed', 'cancelled'].includes(status)) {
      return errorJson(response, 422, 'Статус: new, billed или cancelled');
    }
    const claim = db.prepare('SELECT * FROM demurrage_claims WHERE id=?').get(id);
    if (!claim) return errorJson(response, 404, 'Претензия не найдена');
    db.prepare(`UPDATE demurrage_claims SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(status, id);
    audit(db, user, 'demurrage-status', 'demurrage', id,
      { status, was: claim.status, tripId: claim.trip_id, kind: claim.stop_kind });
    return json(response, 200, { ok: true, status });
  }

  // Отметки «отработано» в заданиях продаж и логиста: общие для команды,
  // привязаны к дате задания. POST — переключатель (есть → снять).
  if (request.method === 'GET' && pathname === '/api/task-marks') {
    const user = requirePermission(request, response, 'planner:read');
    if (!user) return;
    const kind = String(url.searchParams.get('kind') || '');
    const day = String(url.searchParams.get('day') || '');
    if (!['sales', 'logist', 'dispatcher'].includes(kind) || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      return errorJson(response, 422, 'Нужны kind (sales|logist|dispatcher) и day (ГГГГ-ММ-ДД)');
    }
    return json(response, 200, {
      items: db.prepare(`SELECT item_key,done_by,done_at,note FROM task_marks
        WHERE kind=? AND day=? ORDER BY done_at`).all(kind, day)
    });
  }
  if (request.method === 'POST' && pathname === '/api/task-marks') {
    const body = await readJson(request);
    const kind = String(body.kind || '');
    const day = String(body.day || '');
    const key = String(body.key || '').trim().slice(0, 200);
    if (!['sales', 'logist', 'dispatcher'].includes(kind) || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !key) {
      return errorJson(response, 422, 'Нужны kind (sales|logist|dispatcher), day (ГГГГ-ММ-ДД) и key');
    }
    const permissionByKind = { sales: 'orders:write', logist: 'trips:write', dispatcher: 'trip-status:write' };
    // Заметка по рейсу (prepnote) — исключение: её оставляет любой сотрудник,
    // который принял звонок водителя, а не только диспетчер. Комментарий
    // должен дойти до карточки контроля, кто бы ни говорил с водителем.
    const permission = key.startsWith('prepnote|') ? 'planner:read' : permissionByKind[kind];
    const user = requirePermission(request, response, permission);
    if (!user) return;
    const note = String(body.note || '').trim().slice(0, 300);
    const author = user.full_name || user.username || '';
    // Явное снятие (а не переключение): отметка удаляется за оба читаемых дня
    // (сегодня и вчера) — карточка живёт через полночь, и «↩» по вчерашней
    // отметке иначе не срабатывал (кейс р930нт58: отметка 23-го, снятие 24-го
    // удаляло пустоту за «сегодня», вчерашняя продолжала держать карточку).
    if (body.remove) {
      const prevDay = new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
      db.prepare(`DELETE FROM task_marks WHERE kind=? AND item_key=? AND day IN (?,?)`)
        .run(kind, key, day, prevDay);
      return json(response, 200, { done: false });
    }
    const existing = db.prepare(`SELECT 1 FROM task_marks WHERE kind=? AND day=? AND item_key=?`)
      .get(kind, day, key);
    // Отметка контроля на линии — операция диспетчера: фиксируем в аудите
    // для отчёта смены (учёт операций и исполнителей по именам). Ключи
    // claim| (захват) и prepnote| (заметка подготовки) операцией не считаются.
    const isControlOp = kind === 'dispatcher' && !key.startsWith('claim|') && !key.startsWith('prepnote|');
    // Отметка с комментарием — всегда ПОСТАНОВКА (создать или обновить):
    // переключение здесь молча снимало свежий контроль при повторе.
    if (note) {
      if (existing) {
        db.prepare(`UPDATE task_marks SET note=?,done_by=?,done_at=CURRENT_TIMESTAMP
          WHERE kind=? AND day=? AND item_key=?`).run(note, author, kind, day, key);
      } else {
        db.prepare(`INSERT INTO task_marks(kind,day,item_key,done_by,note) VALUES(?,?,?,?,?)`)
          .run(kind, day, key, author, note);
      }
      if (isControlOp) audit(db, user, 'control-worked', 'control', key, { note: true });
      return json(response, 200, { done: true });
    }
    // Явная постановка без комментария (захват «Беру»): создать или обновить
    // автора и время — идемпотентно, без переключения.
    if (body.set) {
      if (existing) {
        db.prepare(`UPDATE task_marks SET done_by=?,done_at=CURRENT_TIMESTAMP
          WHERE kind=? AND day=? AND item_key=?`).run(author, kind, day, key);
      } else {
        db.prepare(`INSERT INTO task_marks(kind,day,item_key,done_by,note) VALUES(?,?,?,?,?)`)
          .run(kind, day, key, author, '');
      }
      return json(response, 200, { done: true });
    }
    // Без комментария — переключатель, как раньше (отметки заданий).
    if (existing) {
      db.prepare(`DELETE FROM task_marks WHERE kind=? AND day=? AND item_key=?`).run(kind, day, key);
    } else {
      db.prepare(`INSERT INTO task_marks(kind,day,item_key,done_by,note) VALUES(?,?,?,?,?)`)
        .run(kind, day, key, author, '');
      if (isControlOp) audit(db, user, 'control-worked', 'control', key, {});
    }
    return json(response, 200, { done: !existing });
  }

  // Файлы потребности клиента: пропуска, схемы проезда, заявки в PDF и т.п.
  // Содержимое — на диске (data/uploads), метаданные — в order_files.
  const orderFilesRoute = route(/^\/api\/orders\/([\w-]+)\/files$/, pathname);
  if (request.method === 'POST' && orderFilesRoute) {
    const user = requirePermission(request, response, 'orders:write');
    if (!user) return;
    const order = db.prepare('SELECT id FROM orders WHERE id=? AND deleted_at IS NULL').get(orderFilesRoute[0]);
    if (!order) return errorJson(response, 404, 'Заявка не найдена');
    let rawName = String(request.headers['x-file-name'] || '');
    try { rawName = decodeURIComponent(rawName); } catch { /* оставляем как есть */ }
    const fileName = cleanFileName(rawName);
    const mime = uploadMimeOf(fileName);
    if (!fileName || !mime) {
      return errorJson(response, 422, 'Такой тип файла нельзя прикрепить — разрешены документы и фото (pdf, jpg, png, docx, xlsx, zip…)');
    }
    const count = db.prepare('SELECT COUNT(*) n FROM order_files WHERE order_id=?').get(order.id).n;
    if (count >= MAX_FILES_PER_ORDER) {
      return errorJson(response, 422, `У заявки уже ${MAX_FILES_PER_ORDER} файлов — удалите лишние`);
    }
    const content = await readRaw(request, MAX_UPLOAD_BYTES);
    if (!content.length) return errorJson(response, 422, 'Файл пустой');
    const id = randomUUID();
    fs.mkdirSync(uploadsPath, { recursive: true });
    fs.writeFileSync(path.join(uploadsPath, id), content);
    db.prepare(`INSERT INTO order_files(id,order_id,file_name,mime,size,uploaded_by)
      VALUES(?,?,?,?,?,?)`).run(id, order.id, fileName, mime, content.length, user.id);
    audit(db, user, 'create', 'order-file', id,
      { orderId: order.id, fileName, size: content.length }, requestIp(request));
    return json(response, 201, {
      file: { id, order_id: order.id, file_name: fileName, mime, size: content.length,
        uploaded_by: user.full_name, uploaded_at: new Date().toISOString() }
    });
  }

  const orderFileRoute = route(/^\/api\/order-files\/([\w-]+)$/, pathname);
  if (request.method === 'GET' && orderFileRoute) {
    const user = requirePermission(request, response, 'planner:read');
    if (!user) return;
    const row = db.prepare('SELECT * FROM order_files WHERE id=?').get(orderFileRoute[0]);
    const filePath = row && path.join(uploadsPath, row.id);
    if (!row || !fs.existsSync(filePath)) return errorJson(response, 404, 'Файл не найден');
    const content = fs.readFileSync(filePath);
    const disposition = INLINE_TYPES.has(row.mime) ? 'inline' : 'attachment';
    response.writeHead(200, {
      'Content-Type': row.mime,
      'Content-Length': content.length,
      'Content-Disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(row.file_name)}`,
      'Cache-Control': 'private, max-age=3600'
    });
    return response.end(content);
  }
  if (request.method === 'DELETE' && orderFileRoute) {
    const user = requirePermission(request, response, 'orders:write');
    if (!user) return;
    const row = db.prepare('SELECT * FROM order_files WHERE id=?').get(orderFileRoute[0]);
    if (!row) return errorJson(response, 404, 'Файл не найден');
    db.prepare('DELETE FROM order_files WHERE id=?').run(row.id);
    try { fs.unlinkSync(path.join(uploadsPath, row.id)); } catch { /* метаданных уже нет */ }
    audit(db, user, 'delete', 'order-file', row.id,
      { orderId: row.order_id, fileName: row.file_name }, requestIp(request));
    return json(response, 200, { ok: true });
  }

  if (request.method === 'GET' && pathname === '/api/customers') {
    const user = requirePermission(request, response, 'customers:read');
    if (!user) return;
    const query = `%${String(url.searchParams.get('q') || '').trim()}%`;
    return json(response, 200, {
      items: db.prepare(`SELECT c.*,f.name from_name,t.name to_name FROM customers c
        LEFT JOIN zones f ON f.id=c.from_zone_id LEFT JOIN zones t ON t.id=c.to_zone_id
        WHERE c.name LIKE ? ORDER BY c.trip_count DESC LIMIT 500`).all(query)
    });
  }
  if (request.method === 'POST' && pathname === '/api/customers') {
    const user = requirePermission(request, response, 'orders:write');
    if (!user) return;
    const body = await readJson(request);
    if (!body.name) return errorJson(response, 422, 'Название заказчика обязательно');
    const id = randomUUID();
    db.prepare(`INSERT INTO customers(id,name,from_zone_id,to_zone_id,trip_count,
      average_rate_vat,trips_per_month) VALUES(?,?,?,?,?,?,?)`).run(
      id, String(body.name).trim(), body.fromZoneId || null, body.toZoneId || null,
      Math.max(0, Number(body.tripCount || 0)), Math.max(0, Number(body.averageRateVat || 0)),
      Math.max(0, Number(body.tripsPerMonth || 0)));
    audit(db, user, 'create', 'customer', id, body, requestIp(request));
    return json(response, 201, { id });
  }
  let match = route(/^\/api\/customers\/([^/]+)$/, pathname);
  if (match && request.method === 'PATCH') {
    const user = requirePermission(request, response, 'orders:write');
    if (!user) return;
    const body = await readJson(request);
    const current = db.prepare('SELECT * FROM customers WHERE id=?').get(match[0]);
    if (!current) return errorJson(response, 404, 'Заказчик не найден');
    db.prepare(`UPDATE customers SET name=?,from_zone_id=?,to_zone_id=?,trip_count=?,
      average_rate_vat=?,trips_per_month=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(
      String(body.name ?? current.name).trim(), body.fromZoneId ?? current.from_zone_id,
      body.toZoneId ?? current.to_zone_id, Number(body.tripCount ?? current.trip_count),
      Number(body.averageRateVat ?? current.average_rate_vat),
      Number(body.tripsPerMonth ?? current.trips_per_month), match[0]);
    audit(db, user, 'update', 'customer', match[0], body, requestIp(request));
    return json(response, 200, { ok: true });
  }
  if (match && request.method === 'DELETE') {
    const user = requirePermission(request, response, 'orders:write');
    if (!user) return;
    const linked = db.prepare('SELECT 1 FROM orders WHERE customer_id=? LIMIT 1').get(match[0]);
    if (linked) return errorJson(response, 409, 'Заказчик используется в заявках');
    db.prepare('DELETE FROM customers WHERE id=?').run(match[0]);
    audit(db, user, 'delete', 'customer', match[0], {}, requestIp(request));
    return json(response, 200, { ok: true });
  }

  if (request.method === 'POST' && pathname === '/api/trips') {
    const user = requirePermission(request, response, 'trips:write');
    if (!user) return;
    const trip = normalizeTrip(await readJson(request));
    const id = randomUUID();
    db.prepare(`INSERT INTO trips(id,vehicle_id,order_id,customer_name,from_zone_id,to_zone_id,
      from_point,to_point,starts_at,ends_at,distance_km,revenue_vat,status,rejection_reason,
      temperature_mode,body_type,created_by,updated_by)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, trip.vehicleId, trip.orderId, trip.customerName, trip.fromZoneId, trip.toZoneId,
      trip.fromPoint, trip.toPoint, trip.startsAt, trip.endsAt, trip.distanceKm, trip.revenueVat,
      trip.status, trip.rejectionReason, trip.temperatureMode, trip.bodyType, user.id, user.id);
    if (trip.orderId) {
      db.prepare(`UPDATE orders SET status='planned',stage=2,trip_id=?,
        assigned_vehicle_id=?,rejection_reason=NULL,returned_at=NULL,
        updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(id, trip.vehicleId, trip.orderId);
      // Рейс из заявки наследует форму оплаты и ID заказа — для экономики по факту.
      db.prepare(`UPDATE trips SET cash=(SELECT cash FROM orders WHERE id=?),
        order_no=(SELECT order_no FROM orders WHERE id=?) WHERE id=?`)
        .run(trip.orderId, trip.orderId, id);
    }
    ensureTripStops(db, id);
    const automatic = integrationPublic().writePolicy === 'automatic';
    queueOutbox(db, 'trips', id, 'create', tripOutboxPayload(id), automatic);
    audit(db, user, 'create', 'trip', id, trip, requestIp(request));
    return json(response, 201, { id });
  }

  match = route(/^\/api\/trips\/([^/]+)$/, pathname);
  if (match && request.method === 'PATCH') {
    const body = await readJson(request);
    const statusOnly = Object.keys(body).every(key => ['status', 'rejectionReason'].includes(key));
    const currentUserForPayment = currentUser(request);
    const permission = statusOnly && body.status === 'paid' && hasPermission(currentUserForPayment, 'payments:write')
      ? 'payments:write' : (statusOnly ? 'trip-status:write' : 'trips:write');
    const user = requirePermission(request, response, permission);
    if (!user) return;
    const current = db.prepare('SELECT * FROM trips WHERE id=?').get(match[0]);
    if (!current) return errorJson(response, 404, 'Рейс не найден');
    // Замена ТС на рейсе, который вывели на линию заранее, но который ещё
    // никуда не выехал: новая сцепка задания не получала — рейс возвращается
    // в подготовку к выходу, иначе задание на вывод на линию диспетчеру
    // не приходит и машина числится «в пути» без единой отметки.
    const vehicleReplaced = body.vehicleId && body.vehicleId !== current.vehicle_id;
    const backToPrep = vehicleReplaced && body.status === undefined &&
      current.status === 'run' && !tripHasMovementFacts(db, current);
    const merged = normalizeTrip({
      // Даты и ТС: пустая строка из формы означает «не менять», а не «стереть» —
      // диспетчер, вернувший статус при случайно очищенном «Окончании», получал
      // 422 «Поле endsAt обязательно» и не мог сохранить (кейс т726ву58).
      vehicleId: body.vehicleId || current.vehicle_id, orderId: body.orderId ?? current.order_id,
      customerName: body.customerName ?? current.customer_name,
      fromZoneId: body.fromZoneId || current.from_zone_id, toZoneId: body.toZoneId || current.to_zone_id,
      fromPoint: body.fromPoint ?? current.from_point, toPoint: body.toPoint ?? current.to_point,
      startsAt: body.startsAt || current.starts_at, endsAt: body.endsAt || current.ends_at,
      distanceKm: body.distanceKm ?? current.distance_km, revenueVat: body.revenueVat ?? current.revenue_vat,
      status: backToPrep ? 'plan' : (body.status ?? current.status),
      rejectionReason: body.rejectionReason ?? current.rejection_reason,
      temperatureMode: body.temperatureMode ?? current.temperature_mode,
      bodyType: body.bodyType ?? current.body_type
    });
    // Отклонение рейса возвращает заявку в продажи, поэтому причина обязательна.
    if (merged.status === 'rejected' && !String(merged.rejectionReason || '').trim()) {
      return errorJson(response, 422, 'Укажите причину отклонения рейса');
    }
    // Рубеж ошибочной отметки: выгрузка более чем за сутки до плановой —
    // почти всегда перепутана машина (кейс т553ве58: рейс в Кемерово закрыли
    // через 31 час после вывода на линию, машина «простаивала», хотя ехала).
    // Клиент передаёт confirmEarly после явного подтверждения диспетчером.
    if (merged.status === 'unloaded' && current.status !== 'unloaded' && !body.confirmEarly) {
      const planEnd = Date.parse(current.ends_at);
      const earlyH = Math.round((planEnd - Date.now()) / 3_600_000);
      if (Number.isFinite(planEnd) && earlyH > 24) {
        return errorJson(response, 422, `До плановой выгрузки ещё ${earlyH} ч — похоже на ошибочную отметку (не та машина?). Проверьте рейс и подтвердите выгрузку ещё раз.`);
      }
    }
    // Возврат статуса из «Выгружен» — рейс продолжается: отметка о выгрузке
    // очищается, иначе машина числится свободной в точке выгрузки (место
    // сцепки, стыковка плеч и занятость считают по unloaded_at), а рейс
    // «В пути» с фактом выгрузки — противоречие, ломавшее все расчёты.
    // Возврат «В пути» → «План» у рейса без единой отметки: шаги «задание
    // водителю» и «на линию» снимаются — диспетчер отметит их заново в
    // реальный момент выхода (кейс инвентаризации: на линию за 3 дня).
    if (merged.status === 'plan' && current.status === 'run' && !tripHasMovementFacts(db, current)) {
      db.prepare(`UPDATE trips SET on_line_at=NULL, driver_notified_at=NULL WHERE id=?`).run(match[0]);
    }
    if (['plan', 'run'].includes(merged.status) &&
        ['unloaded', 'done', 'paid'].includes(current.status)) {
      db.prepare(`UPDATE trips SET unloaded_at=NULL, docs_checked_at=NULL WHERE id=?`).run(match[0]);
    }
    db.prepare(`UPDATE trips SET vehicle_id=?,order_id=?,customer_name=?,from_zone_id=?,to_zone_id=?,
      from_point=?,to_point=?,starts_at=?,ends_at=?,distance_km=?,revenue_vat=?,status=?,rejection_reason=?,
      temperature_mode=?,body_type=?,updated_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(
      merged.vehicleId, merged.orderId, merged.customerName, merged.fromZoneId, merged.toZoneId,
      merged.fromPoint, merged.toPoint,
      merged.startsAt, merged.endsAt, merged.distanceKm, merged.revenueVat, merged.status,
      merged.rejectionReason, merged.temperatureMode, merged.bodyType, user.id, match[0]);
    // Цепочка сцепки изменилась (сдвиг времени, отклонение, смена ТС) —
    // подгон следующих рейсов пересчитываем у обеих машин.
    refreshEmptyKm(merged.vehicleId);
    if (current.vehicle_id && current.vehicle_id !== merged.vehicleId) refreshEmptyKm(current.vehicle_id);
    // Срыв по вине клиента — случай сразу падает претензией в «⏳ Простои П/В».
    // Рейс, уже внесённый в 1С, отклоняется: заказ в учётной системе остаётся
    // висеть — при следующем назначении диспетчер завёл бы второй (дубль).
    // Явное задание: аннулировать или переоформить существующий заказ.
    if (merged.status === 'rejected' && current.status !== 'rejected' &&
        (current.entered_1c_at || current.deferred_1c_at)) {
      const plate = db.prepare('SELECT plate FROM vehicles WHERE id=?').get(current.vehicle_id)?.plate || '—';
      db.prepare(`UPDATE trips SET needs_1c_update_at=?, needs_1c_note=? WHERE id=?`)
        .run(new Date().toISOString(), `рейс отклонён — аннулируйте заказ в 1С (был на ${plate})`, match[0]);
      notify('dispatcher', `🧾 Рейс ${routeText(current)} (${plate}) отклонён, а заказ в 1С уже внесён — ` +
        `аннулируйте или переоформите его, иначе при новом назначении получится дубль`, 'trip', match[0], { category: 'debt_1c' });
    }
    if (merged.status === 'rejected' && current.status !== 'rejected' &&
        FALSE_CALL_REASONS.includes(String(merged.rejectionReason || '').trim())) {
      falseCallClaim({ ...current, order_id: merged.orderId ?? current.order_id },
        String(merged.rejectionReason).trim());
    }
    if (merged.status === 'rejected' && !merged.orderId && current.status !== 'rejected') {
      // Рейс без связанной заявки (например, загружен из 1С): при отклонении
      // потребность не должна пропасть — в продажах создаётся заявка-возврат
      // с пометкой и причиной, окно сдвигается в будущее, если рейс уже шёл.
      const returnOrderId = randomUUID();
      const nowMs = Date.now();
      db.prepare(`INSERT INTO orders(id,customer_name,from_zone_id,to_zone_id,from_point,to_point,
        rate_vat,window_from,window_to,temperature_mode,body_type,status,stage,
        rejection_reason,returned_at,stage_changed_at,order_no,created_by)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,'new',1,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,?,?)`).run(
        returnOrderId, merged.customerName || 'Без заказчика', merged.fromZoneId, merged.toZoneId,
        merged.fromPoint, merged.toPoint, merged.revenueVat,
        new Date(Math.max(Date.parse(merged.startsAt), nowMs)).toISOString(),
        new Date(Math.max(Date.parse(merged.endsAt), nowMs + 86_400_000)).toISOString(),
        merged.temperatureMode, merged.bodyType,
        merged.rejectionReason || 'Отклонён без указания причины', nextOrderNo(db), user.id);
      queueOutbox(db, 'orders', returnOrderId, 'create', orderOutboxPayload(returnOrderId),
        integrationPublic().writePolicy === 'automatic');
      audit(db, user, 'create', 'order', returnOrderId,
        { from: 'rejected-trip', tripId: match[0] }, requestIp(request));
      notify('sales', `Рейс ${routeText(merged.fromPoint ? { from_point: merged.fromPoint, to_point: merged.toPoint } : current)} снят (${merged.rejectionReason}) — в продажах создана заявка-возврат`, 'order', returnOrderId);
    }
    if (merged.orderId) {
      if (merged.status === 'rejected') {
        // Отмена, поломка на маршруте или невозможность перевозки: заявка возвращается
        // в продажи как новая — связь с рейсом и ТС снимается, причина сохраняется.
        db.prepare(`UPDATE orders SET status='new',stage=1,trip_id=NULL,assigned_vehicle_id=NULL,
          rejection_reason=?,returned_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
          WHERE id=?`).run(merged.rejectionReason || 'Отклонён без указания причины', merged.orderId);
        notify('sales', `Рейс ${routeText(current)} отклонён (${merged.rejectionReason || 'без причины'}) — заявка вернулась в продажи`, 'order', merged.orderId);
      } else {
        // Статус рейса двигает стадию конвейера: отмечаем момент перехода,
        // чтобы следующая роль видела, сколько задача у неё ждёт.
        const stage = ({ plan: 2, run: 3, unloaded: 4, done: 4, paid: 5 })[merged.status] ?? 2;
        db.prepare(`UPDATE orders SET stage=?,status='planned',assigned_vehicle_id=?,
          rejection_reason=NULL,returned_at=NULL,
          stage_changed_at=CASE WHEN stage<>? THEN CURRENT_TIMESTAMP ELSE stage_changed_at END,
          updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(
          stage, merged.vehicleId, stage, merged.orderId);
      }
    }
    // Ручная смена статуса проставляет ключевые факты на стоянках контроля;
    // фактическое время события можно передать явно (body.factAt).
    if (merged.status !== current.status && merged.status !== 'rejected') {
      const factAt = body.factAt && Number.isFinite(Date.parse(body.factAt))
        ? new Date(Date.parse(body.factAt)).toISOString() : null;
      ensureTripStops(db, match[0]);
      stampStopsFromStatus(db, match[0], merged.status, factAt);
      if (merged.status === 'unloaded') {
        db.prepare(`UPDATE trips SET unloaded_at=COALESCE(unloaded_at,?) WHERE id=?`)
          .run(factAt || new Date().toISOString(), match[0]);
        notify('accountant', `Рейс ${routeText(current)} выгружен — отметьте оплату`, 'trip', match[0]);
      }
    }
    // Сдвиг рейса (Гант, правка логиста): плановые времена стоянок без фактов
    // следуют за рейсом; если новые даты вышли за окно заявки клиента —
    // продажи получают сигнал (окно — договорённость с клиентом, само не
    // меняется: передоговорить или вернуть рейс в окно).
    if (merged.startsAt !== current.starts_at || merged.endsAt !== current.ends_at) {
      ensureTripStops(db, match[0]);
      rescheduleTripStops(db, match[0]);
      const order = merged.orderId
        ? db.prepare('SELECT order_no,window_from,window_to FROM orders WHERE id=?').get(merged.orderId)
        : null;
      if (order && (Date.parse(merged.startsAt) < Date.parse(order.window_from) - 3_600_000
          || Date.parse(merged.endsAt) > Date.parse(order.window_to) + 3_600_000)) {
        notify('sales', `⏰ Рейс по заявке ${order.order_no ? `№ ${order.order_no} ` : ''}` +
          `(${current.from_point || ''} → ${current.to_point || ''}) сдвинут логистом вне окна клиента: ` +
          `выход ${String(merged.startsAt).slice(0, 16).replace('T', ' ')}, выгрузка ` +
          `${String(merged.endsAt).slice(0, 16).replace('T', ' ')} (UTC) при окне ` +
          `${String(order.window_from).slice(0, 16).replace('T', ' ')} — ` +
          `${String(order.window_to).slice(0, 16).replace('T', ' ')} — передоговорите сроки или верните рейс в окно`,
          'trip', match[0], { category: 'order_deadlines' });
      }
    }
    // Переназначение ТС: задание прежнему водителю отозвано — шаг
    // «Задание водителю отправлено» выполняется заново; порожний подгон
    // пересчитывается от позиции новой сцепки.
    if (merged.vehicleId !== current.vehicle_id) {
      const fromZoneName = db.prepare('SELECT name FROM zones WHERE id=?')
        .get(merged.fromZoneId || current.from_zone_id)?.name;
      db.prepare('UPDATE trips SET empty_km=? WHERE id=?').run(
        emptyKmFor(merged.vehicleId, merged.startsAt || current.starts_at, null,
          (merged.fromPoint ?? current.from_point) || fromZoneName, match[0]), match[0]);
      resetDriverNotificationOnVehicleChange(db, match[0]);
      const oldPlate = db.prepare('SELECT plate FROM vehicles WHERE id=?')
        .get(current.vehicle_id)?.plate || '—';
      const newPlate = db.prepare('SELECT plate FROM vehicles WHERE id=?')
        .get(merged.vehicleId)?.plate || '—';
      // Диспетчеру уходит ОДНО задание со всеми последствиями замены —
      // иначе одно действие рождало два уведомления и работа дробилась.
      const tasks = [];
      if (backToPrep) {
        backToPreparationOnVehicleChange(db, current);
        tasks.push('рейс вернулся в подготовку — отправьте задание водителю и выведите на линию заново');
      } else if (current.status === 'run') {
        // Машина уже в пути (есть факты) — это перецепка: чек-листа у рейса
        // на линии нет, поэтому про задание новому водителю напоминаем явно.
        tasks.push('машина уже в пути — передайте задание новому водителю');
      }
      // Данные в 1С устарели: если заказ уже внесён (или внесение отложено),
      // диспетчеру ставится задание обновить ТС в учётной системе.
      if (current.entered_1c_at || current.deferred_1c_at) {
        db.prepare(`UPDATE trips SET needs_1c_update_at=?, needs_1c_note=?, debt_1c_alert_at=NULL
          WHERE id=?`).run(new Date().toISOString(),
          `ТС: было ${oldPlate} → стало ${newPlate}`, match[0]);
        tasks.push('обновите данные в 1С и отметьте «✓ 1С обновлено» в карточке рейса');
      }
      if (tasks.length) {
        notify('dispatcher', `🔁 Замена ТС на рейсе ${routeText(current)}: ${oldPlate} → ${newPlate}. ` +
          `${tasks.map((text, index) => `${index + 1}) ${text}`).join('; ')}`, 'trip', match[0]);
      }
      // Новому водителю — задание в Telegram (если привязан).
      sendDriverAssignment(match[0]);
    }
    queueOutbox(db, 'trips', match[0], 'update', tripOutboxPayload(match[0]),
      integrationPublic().writePolicy === 'automatic');
    audit(db, user, 'update', 'trip', match[0], body, requestIp(request));
    return json(response, 200, { ok: true });
  }
  if (match && request.method === 'DELETE') {
    const user = requirePermission(request, response, 'trips:write');
    if (!user) return;
    const current = db.prepare('SELECT * FROM trips WHERE id=?').get(match[0]);
    if (!current) return errorJson(response, 404, 'Рейс не найден');
    db.prepare(`UPDATE orders SET trip_id=NULL,assigned_vehicle_id=NULL,status='new',stage=1
      WHERE trip_id=?`).run(match[0]);
    db.prepare('DELETE FROM trip_stops WHERE trip_id=?').run(match[0]);
    db.prepare('DELETE FROM trips WHERE id=?').run(match[0]);
    refreshEmptyKm(current.vehicle_id);
    queueOutbox(db, 'trips', match[0], 'delete', { externalId: current.external_id },
      integrationPublic().writePolicy === 'automatic');
    audit(db, user, 'delete', 'trip', match[0], {}, requestIp(request));
    return json(response, 200, { ok: true });
  }


  // Промежуточные пункты заявки: [{point, kind P/D, addressId}], до 8 штук.
  function parseVia(value) {
    if (!Array.isArray(value)) return null;
    return value.slice(0, 8).map(item => ({
      point: String(item?.point || '').trim().slice(0, 120),
      kind: item?.kind === 'P' ? 'P' : 'D',
      addressId: item?.addressId || null
    })).filter(item => item.point);
  }
  // Плановый километраж заявки: цепочка погрузка → промежуточные → выгрузка
  // по координатам справочника (точки без адреса пропускаются в километраже,
  // но считаются грузовой операцией в транзитном времени).
  function plannedKmFor(fromAddressId, toAddressId, via = []) {
    if (!fromAddressId || !toAddressId) return null;
    const point = db.prepare('SELECT latitude,longitude FROM addresses WHERE id=?');
    const chain = [point.get(fromAddressId),
      ...via.map(item => item.addressId ? point.get(item.addressId) : null).filter(Boolean),
      point.get(toAddressId)].filter(Boolean);
    if (chain.length < 2) return null;
    let total = 0;
    for (let i = 1; i < chain.length; i += 1) {
      const leg = roadKm(chain[i - 1].latitude, chain[i - 1].longitude,
        chain[i].latitude, chain[i].longitude);
      if (leg == null) return null;
      total += leg;
    }
    return total;
  }

  // Telegram: одноразовый код привязки чата и смена режима уведомлений.
  if (request.method === 'POST' && pathname === '/api/telegram/link') {
    const user = requireUser(request, response);
    if (!user) return;
    if (!telegramConfig().botToken) return errorJson(response, 422, 'Бот не настроен (Настройки → Telegram)');
    const code = randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
    db.prepare(`INSERT INTO app_meta(key,value) VALUES(?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
      .run(`tg_link_${code}`, JSON.stringify({ userId: user.id, exp: Date.now() + 15 * 60_000 }));
    // Имя бота для ссылки t.me — строго username: если админ записал
    // человекочитаемое имя («Pegas Planer»), ссылка вела в никуда. Берём
    // настоящий username у самого Telegram (getMe) и чиним настройку.
    let botName = String(telegramConfig().botName || '');
    if (!/^[A-Za-z0-9_]{5,}$/.test(botName)) {
      const me = await tgApi('getMe', {});
      if (me?.ok && me.result?.username) {
        botName = me.result.username;
        db.prepare(`INSERT INTO settings(key,value_json,updated_by,updated_at)
          VALUES('telegram',?,?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET
          value_json=excluded.value_json,updated_at=CURRENT_TIMESTAMP`)
          .run(JSON.stringify({ ...telegramConfig(), botName }), user.id);
      } else botName = '';
    }
    return json(response, 200, { code, botName });
  }
  if (request.method === 'POST' && pathname === '/api/telegram/mode') {
    const user = requireUser(request, response);
    if (!user) return;
    const body = await readJson(request);
    if (body.mode === 'off') {
      db.prepare(`UPDATE users SET telegram_chat_id=NULL WHERE id=?`).run(user.id);
      return json(response, 200, { ok: true });
    }
    if (!['critical', 'all'].includes(body.mode)) return errorJson(response, 422, 'Режим: critical | all | off');
    db.prepare(`UPDATE users SET telegram_mode=? WHERE id=?`).run(body.mode, user.id);
    return json(response, 200, { ok: true });
  }
  if (request.method === 'GET' && pathname === '/api/addresses') {
    if (!requireUser(request, response)) return;
    return json(response, 200, {
      items: db.prepare(`SELECT a.*,z.name zone_name FROM addresses a
        LEFT JOIN zones z ON z.id=a.zone_id ORDER BY a.name`).all()
    });
  }
  // Ревизия зон справочника: адреса, у которых подсказка по субъекту/городу
  // расходится с проставленной зоной. Только список — правит человек.
  if (request.method === 'GET' && pathname === '/api/addresses/audit') {
    if (!requirePermission(request, response, 'orders:write')) return;
    const items = [];
    for (const address of db.prepare(`SELECT a.id, a.name, a.region, a.zone_id, a.latitude,
        a.longitude, z.name AS zone,
        (SELECT COUNT(*) FROM orders o WHERE o.from_address_id=a.id OR o.to_address_id=a.id) AS used
        FROM addresses a LEFT JOIN zones z ON z.id=a.zone_id`).all()) {
      const hint = zoneHintForAddress(`${address.name} ${address.region || ''}`,
        address.latitude, address.longitude);
      if (hint && hint.id !== address.zone_id) {
        items.push({ id: address.id, name: address.name, zone: address.zone || null,
          shouldBe: hint.name, shouldBeId: hint.id, via: hint.via, used: address.used });
      }
    }
    items.sort((a, b) => b.used - a.used);
    return json(response, 200, { items });
  }
  // Правка пункта (имя, адрес, субъект, зона, координаты). Смена зоны
  // пересчитывает АКТИВНЫЕ заявки по пункту (окно не в прошлом) и их
  // незакрытые рейсы: зоны копируются в заявку при создании и сами не
  // обновляются — без пересчёта фильтры продолжали бы врать.
  if (request.method === 'PATCH' && (match = route(/^\/api\/addresses\/([\w-]+)$/, pathname))) {
    const user = requirePermission(request, response, 'orders:write');
    if (!user) return;
    const body = await readJson(request);
    const address = db.prepare('SELECT * FROM addresses WHERE id=?').get(match[0]);
    if (!address) return errorJson(response, 404, 'Пункт не найден');
    const name = body.name !== undefined ? String(body.name || '').trim() : address.name;
    if (!name) return errorJson(response, 422, 'Укажите наименование пункта');
    if (name !== address.name &&
        db.prepare('SELECT 1 FROM addresses WHERE name=? COLLATE NOCASE AND id<>?').get(name, match[0])) {
      return errorJson(response, 422, 'Такой пункт уже есть в справочнике');
    }
    const zoneId = body.zoneId !== undefined ? body.zoneId : address.zone_id;
    if (!zoneId || !db.prepare('SELECT 1 FROM zones WHERE id=?').get(zoneId)) {
      return errorJson(response, 422, 'Укажите геозону');
    }
    const numOf = (value, current) => value === undefined ? current
      : (value === '' || value === null ? null : Number(value));
    const latitude = numOf(body.latitude, address.latitude);
    const longitude = numOf(body.longitude, address.longitude);
    const { BASE_POINT } = await import('./db.mjs');
    db.prepare(`UPDATE addresses SET name=?, address=?, region=?, zone_id=?,
        latitude=?, longitude=?, base_distance_km=? WHERE id=?`).run(
      name,
      body.address !== undefined ? String(body.address || '').trim() : address.address,
      body.region !== undefined ? String(body.region || '').trim() : address.region,
      zoneId, latitude, longitude,
      Number.isFinite(latitude) && Number.isFinite(longitude)
        ? roadKm(latitude, longitude, BASE_POINT.lat, BASE_POINT.lon) : null,
      match[0]);
    let touched = 0;
    if (zoneId !== address.zone_id) {
      for (const [addrCol, zoneCol] of [['from_address_id', 'from_zone_id'], ['to_address_id', 'to_zone_id']]) {
        const orders = db.prepare(`SELECT id, trip_id FROM orders
          WHERE ${addrCol}=? AND ${zoneCol}!=? AND deleted_at IS NULL
            AND window_to >= date('now', '-1 day')`).all(match[0], zoneId);
        for (const order of orders) {
          db.prepare(`UPDATE orders SET ${zoneCol}=? WHERE id=?`).run(zoneId, order.id);
          if (order.trip_id) {
            db.prepare(`UPDATE trips SET ${zoneCol}=? WHERE id=? AND status IN ('plan','run')`)
              .run(zoneId, order.trip_id);
          }
          touched += 1;
        }
      }
    }
    audit(db, user, 'update', 'address', match[0],
      { ...body, was: { name: address.name, zone_id: address.zone_id }, ordersTouched: touched },
      requestIp(request));
    return json(response, 200, { ok: true, ordersTouched: touched });
  }
  // Удаление пункта: только не используемого заявками — история заявок
  // важнее чистоты справочника, ссылки не рвём.
  if (request.method === 'DELETE' && (match = route(/^\/api\/addresses\/([\w-]+)$/, pathname))) {
    const user = requirePermission(request, response, 'orders:write');
    if (!user) return;
    const address = db.prepare('SELECT * FROM addresses WHERE id=?').get(match[0]);
    if (!address) return errorJson(response, 404, 'Пункт не найден');
    const used = db.prepare(`SELECT COUNT(*) n FROM orders
      WHERE from_address_id=? OR to_address_id=?`).get(match[0], match[0]).n;
    if (used) {
      return errorJson(response, 422,
        `Пункт используется в ${used} заявках — удалить нельзя. Поправьте его через «✏», если данные неверны`);
    }
    db.prepare('DELETE FROM addresses WHERE id=?').run(match[0]);
    audit(db, user, 'delete', 'address', match[0], { name: address.name }, requestIp(request));
    return json(response, 200, { ok: true });
  }
  if (request.method === 'POST' && pathname === '/api/addresses') {
    const user = requirePermission(request, response, 'orders:write');
    if (!user) return;
    const body = await readJson(request);
    const name = String(body.name || '').trim();
    if (!name) return errorJson(response, 422, 'Укажите наименование пункта');
    if (db.prepare('SELECT 1 FROM addresses WHERE name=? COLLATE NOCASE').get(name)) {
      return errorJson(response, 422, 'Такой пункт уже есть в справочнике');
    }
    let latitude = Number.isFinite(Number(body.latitude)) && body.latitude !== ''
      ? Number(body.latitude) : null;
    let longitude = Number.isFinite(Number(body.longitude)) && body.longitude !== ''
      ? Number(body.longitude) : null;
    // Координат нет — подтягиваем из общего классификатора (OSM) сами:
    // без них не считается ни подгон, ни плановый километраж, а кнопку
    // «🌍 Найти» нажимали не всегда (кейс Раевского). Неудача геокода
    // создание не блокирует — досчитает ночной сторож.
    if (latitude == null || longitude == null) {
      try {
        const [hit] = await geocodeQuery(String(body.address || '').trim() || name);
        if (hit) {
          latitude = hit.latitude;
          longitude = hit.longitude;
          if (!String(body.region || '').trim()) body.region = hit.region;
        }
      } catch { /* классификатор недоступен — сторож дотянет позже */ }
    }
    // Зона не выбрана — единая подсказка: субъект РФ, затем координаты
    // (после геокода), затем город в имени.
    if (!body.zoneId) {
      body.zoneId = zoneHintForAddress(`${name} ${body.region || ''}`, latitude, longitude)?.id || null;
    }
    const id = randomUUID();
    const { BASE_POINT } = await import('./db.mjs');
    db.prepare(`INSERT INTO addresses(id,external_code,name,address,region,zone_id,latitude,longitude,base_distance_km)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(
      id, null, name, String(body.address || '').trim(),
      String(body.region || '').trim(),
      body.zoneId || null, latitude, longitude,
      latitude != null && longitude != null
        ? roadKm(latitude, longitude, BASE_POINT.lat, BASE_POINT.lon) : null);
    audit(db, user, 'create', 'address', id, body, requestIp(request));
    return json(response, 201, { id });
  }

  if (request.method === 'POST' && pathname === '/api/orders') {
    const user = requirePermission(request, response, 'orders:write');
    if (!user) return;
    const body = await readJson(request);
    // Геозоны убраны из формы продаж — они определяются по пункту сами:
    // зона адреса справочника, иначе алиас/имя зоны из текста. Менеджер
    // заполняет адреса, а не служебную географию.
    const zoneOfPlace = (addressId, text) => {
      const byAddress = addressId
        ? db.prepare('SELECT zone_id FROM addresses WHERE id=?').get(addressId)?.zone_id : null;
      if (byAddress) return byAddress;
      const byCity = db.prepare(`SELECT zone_id FROM addresses
        WHERE name LIKE ? AND zone_id IS NOT NULL LIMIT 1`)
        .get(`${String(text || '').split(',')[0].trim()}%`)?.zone_id;
      return byCity || resolveZone(db, String(text || '').split(',')[0])?.id
        || zoneHintForAddress(text)?.id || null;
    };
    if (!body.fromZoneId) body.fromZoneId = zoneOfPlace(body.fromAddressId, body.fromPoint);
    if (!body.toZoneId) body.toZoneId = zoneOfPlace(body.toAddressId, body.toPoint);
    for (const key of ['customerName', 'fromZoneId', 'toZoneId', 'windowFrom', 'windowTo']) {
      if (!body[key]) {
        return errorJson(response, 422, key.includes('ZoneId')
          ? `Не удалось определить геозону по пункту ${key === 'fromZoneId' ? 'погрузки' : 'выгрузки'} — выберите адрес из справочника`
          : `Поле ${key} обязательно`);
      }
    }
    const windowFrom = Date.parse(body.windowFrom);
    const windowTo = Date.parse(body.windowTo);
    if (!Number.isFinite(windowFrom) || !Number.isFinite(windowTo) || windowTo <= windowFrom) {
      return errorJson(response, 422, 'Некорректное окно заявки');
    }
    // Рубеж заднего числа: погрузка в прошлом — почти всегда ошибка даты
    // (случай №2710: продажи указали август вместо сентября, и рейс висел
    // «в работе» месяц). Осознанное внесение по факту — с подтверждением.
    if (windowFrom < Date.now() - 12 * 3_600_000 && !body.confirmPast) {
      return errorJson(response, 422, `Погрузка в прошлом (${mskStamp(windowFrom)} МСК) — проверьте дату и МЕСЯЦ. Если заявка сознательно вносится задним числом, подтвердите ещё раз`);
    }
    // Новый клиент из свободного ввода автоматически попадает в справочник
    // и прикрепляется к геозонам первой заявки (основное направление).
    const customerName = body.customerName.trim();
    if (!db.prepare('SELECT 1 FROM customers WHERE name=? COLLATE NOCASE').get(customerName)) {
      const customerId = randomUUID();
      db.prepare(`INSERT INTO customers(id,name,from_zone_id,to_zone_id,trip_count,
        average_rate_vat,trips_per_month) VALUES(?,?,?,?,0,?,0)`).run(
        customerId, customerName, body.fromZoneId, body.toZoneId, Number(body.rateVat || 0));
      audit(db, user, 'create', 'customer', customerId,
        { name: customerName, auto: 'from-order' }, requestIp(request));
    }
    const id = randomUUID();
    const orderNo = nextOrderNo(db);
    const via = parseVia(body.via) || [];
    const plannedKm = plannedKmFor(body.fromAddressId, body.toAddressId, via);
    db.prepare(`INSERT INTO orders(id,customer_name,from_zone_id,to_zone_id,from_point,to_point,
      rate_vat,window_from,window_to,temperature_mode,body_type,stage,comment,order_no,cash,
      from_address_id,to_address_id,planned_km,via_json,created_by)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, customerName, body.fromZoneId, body.toZoneId,
      String(body.fromPoint || '').trim(), String(body.toPoint || '').trim(), Number(body.rateVat || 0),
      new Date(windowFrom).toISOString(), new Date(windowTo).toISOString(),
      String(body.temperatureMode || ''), String(body.bodyType || ''), Number(body.stage || 0),
      String(body.comment || '').trim().slice(0, 500),
      orderNo, body.cash ? 1 : 0,
      body.fromAddressId || null, body.toAddressId || null, plannedKm,
      JSON.stringify(via), user.id);
    queueOutbox(db, 'orders', id, 'create', orderOutboxPayload(id),
      integrationPublic().writePolicy === 'automatic');
    audit(db, user, 'create', 'order', id, body, requestIp(request));
    return json(response, 201, { id, orderNo });
  }
  match = route(/^\/api\/orders\/([^/]+)$/, pathname);
  if (match && request.method === 'PATCH') {
    // Отклонять заявку могут и продажи, и логисты — отказ возможен с обеих сторон процесса.
    const actor = currentUser(request);
    const permission = hasPermission(actor, 'orders:write') ? 'orders:write' : 'trips:write';
    const user = requirePermission(request, response, permission);
    if (!user) return;
    const body = await readJson(request);
    const current = db.prepare('SELECT * FROM orders WHERE id=?').get(match[0]);
    if (!current) return errorJson(response, 404, 'Заявка не найдена');
    const starts = Date.parse(body.windowFrom ?? current.window_from);
    const ends = Date.parse(body.windowTo ?? current.window_to);
    if (!Number.isFinite(starts) || !Number.isFinite(ends) || ends <= starts) {
      return errorJson(response, 422, 'Некорректное окно заявки');
    }
    // Тот же рубеж на правке: НОВОЕ окно в прошлом блокируется (старую
    // заявку с прошедшей погрузкой пересохранять без смены окна можно).
    if (body.windowFrom && Date.parse(body.windowFrom) !== Date.parse(current.window_from)
        && starts < Date.now() - 12 * 3_600_000 && !body.confirmPast) {
      return errorJson(response, 422, `Погрузка в прошлом (${mskStamp(starts)} МСК) — проверьте дату и МЕСЯЦ. Если перенос задним числом сознателен, подтвердите ещё раз`);
    }
    const nextStatus = body.status ?? current.status;
    // Стадия конвейера: фиксируем момент перехода (по нему видно, сколько заявка ждёт)
    // и отдельно — подтверждение продажами для реестра в отчёте.
    const nextStage = Number(body.stage ?? current.stage);
    const stageChanged = nextStage !== Number(current.stage);
    // Отклонение заявки без причины запрещено: реестр отклонённых должен объяснять отказ.
    let rejectionReason = current.rejection_reason;
    let returnedAt = current.returned_at;
    if (nextStatus === 'cancelled') {
      const reason = String(body.rejectionReason ?? '').trim();
      if (!reason) return errorJson(response, 422, 'Укажите причину отклонения заявки');
      rejectionReason = reason;
      returnedAt = null;
    } else if (nextStatus === 'new' && current.status === 'cancelled') {
      // Возврат отклонённой заявки в работу очищает историю отказа.
      rejectionReason = null;
      returnedAt = null;
    } else if (stageChanged && nextStage >= 1) {
      // Заявка двинулась по конвейеру — возврат из плана отработан, пометка снимается.
      rejectionReason = null;
      returnedAt = null;
    }
    const confirmedAt = current.confirmed_at ||
      (stageChanged && nextStage >= 1 ? new Date().toISOString() : null);
    const keptOrderNo = current.order_no || '';
    const nextCash = 'cash' in body ? (body.cash ? 1 : 0) : Number(current.cash || 0);
    const nextFromAddress = 'fromAddressId' in body ? (body.fromAddressId || null) : current.from_address_id;
    const nextToAddress = 'toAddressId' in body ? (body.toAddressId || null) : current.to_address_id;
    const nextVia = parseVia(body.via) ?? JSON.parse(current.via_json || '[]');
    const nextPlannedKm = plannedKmFor(nextFromAddress, nextToAddress, nextVia) ?? current.planned_km;
    db.prepare(`UPDATE orders SET customer_name=?,from_zone_id=?,to_zone_id=?,from_point=?,to_point=?,
      rate_vat=?,window_from=?,window_to=?,status=?,temperature_mode=?,body_type=?,stage=?,comment=?,
      order_no=?,cash=?,from_address_id=?,to_address_id=?,planned_km=?,via_json=?,
      rejection_reason=?,returned_at=?,confirmed_at=?,
      stage_changed_at=CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE stage_changed_at END,
      updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(
      String(body.customerName ?? current.customer_name).trim(),
      body.fromZoneId ?? current.from_zone_id, body.toZoneId ?? current.to_zone_id,
      String(body.fromPoint ?? current.from_point ?? '').trim(),
      String(body.toPoint ?? current.to_point ?? '').trim(),
      Number(body.rateVat ?? current.rate_vat), new Date(starts).toISOString(),
      new Date(ends).toISOString(), nextStatus,
      String(body.temperatureMode ?? current.temperature_mode),
      String(body.bodyType ?? current.body_type), nextStage,
      String(body.comment ?? current.comment ?? '').trim().slice(0, 500),
      keptOrderNo, nextCash, nextFromAddress, nextToAddress, nextPlannedKm,
      JSON.stringify(nextVia),
      rejectionReason, returnedAt, confirmedAt, stageChanged ? 1 : 0, match[0]);
    // Заявка уже в плане у логиста: ставка, форма оплаты и ID заказа —
    // атрибуты выручки рейса, синхронизируем, пока рейс не закрыт оплатой.
    if (current.trip_id && (('rateVat' in body &&
        Number(body.rateVat) !== Number(current.rate_vat)) ||
        nextCash !== Number(current.cash || 0))) {
      // Ставка изменилась после уточнения диспетчером — уточнение сбрасывается,
      // в подготовке выхода снова загорится «Уточнить сумму по заявке клиента».
      db.prepare(`UPDATE trips SET revenue_vat=?,cash=?,order_no=?,
          sum_confirmed_at=NULL,sum_confirmed_by=NULL,
          updated_by=?,updated_at=CURRENT_TIMESTAMP
        WHERE id=? AND status NOT IN ('paid','rejected')`)
        .run(Number(body.rateVat ?? current.rate_vat), nextCash, keptOrderNo, user.id, current.trip_id);
      queueOutbox(db, 'trips', current.trip_id, 'update', tripOutboxPayload(current.trip_id),
        integrationPublic().writePolicy === 'automatic');
    }
    // Сменились адреса — новый плановый километраж уходит в незакрытый рейс.
    if (current.trip_id && nextPlannedKm && nextPlannedKm !== current.planned_km) {
      db.prepare(`UPDATE trips SET distance_km=?,updated_by=?,updated_at=CURRENT_TIMESTAMP
        WHERE id=? AND status NOT IN ('paid','rejected')`)
        .run(nextPlannedKm, user.id, current.trip_id);
    }
    // Пункты, геозоны и ОКНО заявки — в незавершённый рейс (план / в пути):
    // заявка клиента — источник истины, рейс перепланируется за ней.
    // План: начало = окно «с», конец = max(начало + транзит, окно «по»).
    // В пути: начало уже факт, пересчитывается только конец. Стоянки без
    // фактов следуют за рейсом, логист получает уведомление о сдвиге.
    if (current.trip_id) {
      const trip = db.prepare(`SELECT * FROM trips WHERE id=? AND status IN ('plan','run')`)
        .get(current.trip_id);
      if (trip) {
        const nextFromPoint = String(body.fromPoint ?? current.from_point ?? '').trim();
        const nextToPoint = String(body.toPoint ?? current.to_point ?? '').trim();
        const nextFromZone = body.fromZoneId ?? current.from_zone_id;
        const nextToZone = body.toZoneId ?? current.to_zone_id;
        const calc = settingsObject(db).calculation;
        const newStart = trip.status === 'plan' ? new Date(starts).toISOString() : trip.starts_at;
        const transitMs = transitHours(Number(trip.distance_km || nextPlannedKm || 500), calc,
          2 + nextVia.length) * 3_600_000;
        const newEnd = new Date(Math.max(Date.parse(newStart) + transitMs, ends)).toISOString();
        const datesChanged = newStart !== trip.starts_at || newEnd !== trip.ends_at;
        const placesChanged = nextFromPoint !== (trip.from_point || '') || nextToPoint !== (trip.to_point || '')
          || nextFromZone !== trip.from_zone_id || nextToZone !== trip.to_zone_id;
        if (datesChanged || placesChanged) {
          db.prepare(`UPDATE trips SET from_point=?,to_point=?,from_zone_id=?,to_zone_id=?,
              starts_at=?,ends_at=?,updated_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
            .run(nextFromPoint, nextToPoint, nextFromZone, nextToZone, newStart, newEnd,
              user.id, trip.id);
          ensureTripStops(db, trip.id);
          rescheduleTripStops(db, trip.id);
          queueOutbox(db, 'trips', trip.id, 'update', tripOutboxPayload(trip.id),
            integrationPublic().writePolicy === 'automatic');
          if (datesChanged) {
            notify('logist', `📝 Продажи изменили заявку ${keptOrderNo ? `№ ${keptOrderNo} ` : ''}` +
              `(${nextFromPoint || '—'} → ${nextToPoint || '—'}): рейс перепланирован — выход ` +
              `${newStart.slice(0, 16).replace('T', ' ')}, выгрузка ${newEnd.slice(0, 16).replace('T', ' ')} (UTC)`,
              'trip', trip.id);
          }
        }
        // Промежуточные точки рейса следуют за маршрутом заявки: сверка на
        // каждом сохранении (идемпотентно), а не только при «изменении» —
        // так лечатся и рейсы, разъехавшиеся с заявкой раньше.
        ensureTripStops(db, trip.id);
        const viaSync = syncTripStopsWithVia(db, trip.id, nextVia, user.id);
        if (viaSync.added || viaSync.removed) {
          notify('dispatcher', `🧭 Продажи изменили маршрут заявки ${keptOrderNo ? `№ ${keptOrderNo} ` : ''}` +
            `(${current.customer_name}): точки рейса обновлены (добавлено ${viaSync.added}, убрано ${viaSync.removed}). ` +
            `Проверьте карточку контроля`, 'trip', trip.id, { category: 'other' });
          // Водитель уже получил задание — досылаем обновлённое с новым маршрутом.
          if (trip.driver_notified_at) sendDriverAssignment(trip.id);
          queueOutbox(db, 'trips', trip.id, 'update', tripOutboxPayload(trip.id),
            integrationPublic().writePolicy === 'automatic');
        }
        // Подгон следует за датами заявки: перенос окна (в т.ч. исправление
        // ошибочного месяца, №2710: 1647 км от августовской цепочки) меняет
        // позицию сцепки перед стартом. refreshEmptyKm не трогает начавшиеся
        // рейсы, поэтому здесь пересчёт точечный и идемпотентный.
        const freshEmpty = emptyKmFor(trip.vehicle_id, newStart, nextFromAddress,
          String(body.fromPoint ?? current.from_point ?? '').trim(), trip.id);
        if (freshEmpty != null && Math.abs(Number(trip.empty_km || 0) - freshEmpty) > 1) {
          db.prepare('UPDATE trips SET empty_km=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
            .run(freshEmpty, trip.id);
          refreshEmptyKm(trip.vehicle_id);
        }
      }
    }
    // Уведомление следующего участника: продажи подтвердили — ход логиста.
    if (stageChanged && nextStage === 1 && Number(current.stage) === 0) {
      notify('logist', `Заявка «${current.customer_name}» ${routeText(current)} подтверждена продажами — назначьте ТС`, 'order', match[0]);
    }
    queueOutbox(db, 'orders', match[0], 'update', orderOutboxPayload(match[0]),
      integrationPublic().writePolicy === 'automatic');
    audit(db, user, 'update', 'order', match[0], body, requestIp(request));
    return json(response, 200, { ok: true });
  }
  if (match && request.method === 'DELETE') {
    // Удаление отклонённой заявки — мягкое: из оперативных списков уходит,
    // в БД остаётся и попадает в реестр отклонённых отчёта для аналитики.
    const user = requirePermission(request, response, 'orders:write');
    if (!user) return;
    const current = db.prepare('SELECT * FROM orders WHERE id=?').get(match[0]);
    if (!current) return errorJson(response, 404, 'Заявка не найдена');
    if (current.status !== 'cancelled') {
      return errorJson(response, 409, 'Удалять можно только отклонённые заявки');
    }
    db.prepare(`UPDATE orders SET deleted_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
      WHERE id=?`).run(match[0]);
    audit(db, user, 'delete', 'order', match[0], { soft: true }, requestIp(request));
    return json(response, 200, { ok: true });
  }
  // Ядро назначения: транзит, рейс, стоянки, порожняк, каскад заявки —
  // используется одиночным assign и цепным назначением маршрута.
  function assignOrderCore(order, vehicle, user, { startsAt: startsAtOverride, distanceKm } = {}) {
    const settings = settingsObject(db).calculation;
    const rate = db.prepare(`SELECT distance_km FROM route_rates
      WHERE (from_zone_id=? AND to_zone_id=?) OR (from_zone_id=? AND to_zone_id=?)
      LIMIT 1`).get(order.from_zone_id, order.to_zone_id, order.to_zone_id, order.from_zone_id);
    // Плановый километраж по адресам заявки — приоритет; зонный тариф — фолбэк.
    const distance = Number(distanceKm || order.planned_km || rate?.distance_km || 500);
    const startsAt = startsAtOverride || order.window_from;
    // Транзит: (км/50 + операции×3ч) × 1,5 — каждая промежуточная погрузка
    // и выгрузка добавляет операцию. Окно клиента шире расчёта — план по окну.
    const orderVia = (() => { try { return JSON.parse(order.via_json || '[]'); } catch { return []; } })();
    const transitEnd = Date.parse(startsAt) +
      transitHours(distance, settings, 2 + orderVia.length) * 3_600_000;
    const endsAt = new Date(Math.max(transitEnd, Date.parse(order.window_to || 0))).toISOString();
    const tripId = order.trip_id || randomUUID();
    // Двойное назначение: сцепка уже занята рейсом в этот период (допуск 6 ч —
    // стык план/факт с погрешностью не блокируем, грубое наложение — да).
    const clash = db.prepare(`SELECT starts_at,ends_at,from_point,to_point,order_no FROM trips
      WHERE vehicle_id=? AND status IN ('plan','run') AND id<>?
        AND starts_at < ? AND ? < ends_at`).all(vehicle.id, tripId, endsAt, startsAt)
      .find(existing => Math.min(Date.parse(existing.ends_at), Date.parse(endsAt)) -
        Math.max(Date.parse(existing.starts_at), Date.parse(startsAt)) > 6 * 3_600_000);
    if (clash) {
      const err = new Error(`Сцепка занята рейсом ${clash.order_no ? `№${clash.order_no} ` : ''}` +
        `${clash.from_point || ''} → ${clash.to_point || ''} до ${clash.ends_at.slice(0, 16).replace('T', ' ')} — выберите другое ТС или время`);
      err.status = 422;
      throw err;
    }
    // Последний рубеж кузова — для ВСЕХ путей назначения (логист, черновики,
    // конструктор): тушевозный груз в паллетник сервер не пропустит.
    const vehicleTypeName = db.prepare(`SELECT vt.name FROM vehicle_types vt
      WHERE vt.id=?`).get(vehicle.type_id)?.name;
    if (!bodyTypeMatches(order.body_type, vehicleTypeName)) {
      const err = new Error(`Кузов заявки «${order.body_type}» не подходит типу ТС ` +
        `«${vehicleTypeName || '—'}» — выберите совместимую сцепку`);
      err.status = 422;
      throw err;
    }
    // Последний рубеж: клиентский подбор фильтрует занятых, но назначение
    // приходит и из черновиков, и из API — машина в ремонте/без водителя
    // на интервале рейса не назначается (резерв — можно: он и означает
    // «обещана заказу»; перегон блокирует, пока не прибыл).
    const blockingDispo = db.prepare(`SELECT kind, ends_at FROM vehicle_dispositions
      WHERE vehicle_id=? AND kind<>'reserve'
        AND (kind<>'transfer' OR arrived_at IS NULL)
        AND datetime(starts_at) < datetime(?) AND datetime(ends_at) > datetime(?)
      ORDER BY ends_at DESC LIMIT 1`).get(vehicle.id, endsAt, startsAt);
    if (blockingDispo) {
      const label = ({ repair: 'в ремонте', no_driver: 'без водителя', shift: 'на пересменке',
        out: 'выведена', transfer: 'в перегоне' })[blockingDispo.kind] || blockingDispo.kind;
      const err = new Error(`Сцепка ${label} до ` +
        `${blockingDispo.ends_at.slice(0, 16).replace('T', ' ')} (UTC) — рейс пересекает интервал. ` +
        `Выберите другое ТС или скорректируйте интервал в «Ресурсе»`);
      err.status = 422;
      throw err;
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      const assignEmptyKm = emptyKmFor(vehicle.id, startsAt,
        order.from_address_id, order.from_point || null, tripId);
      if (order.trip_id) {
        // Переназначение: заявка уже имела рейс с другой машиной. Если заказ
        // внесён в 1С — диспетчер обязан узнать, ВМЕСТО какой машины пришла
        // новая, иначе он заведёт второй заказ и в учётной системе дубль.
        const previous = db.prepare(`SELECT t.vehicle_id, t.entered_1c_at, t.deferred_1c_at,
            v.plate FROM trips t JOIN vehicles v ON v.id=t.vehicle_id WHERE t.id=?`).get(tripId);
        db.prepare(`UPDATE trips SET vehicle_id=?,status='plan',cash=?,order_no=?,empty_km=?,
          updated_by=?,updated_at=CURRENT_TIMESTAMP
          WHERE id=?`).run(vehicle.id, Number(order.cash || 0), order.order_no || '',
          assignEmptyKm, user.id, tripId);
        if (previous && previous.vehicle_id !== vehicle.id) {
          resetDriverNotificationOnVehicleChange(db, tripId);
          if (previous.entered_1c_at || previous.deferred_1c_at) {
            db.prepare(`UPDATE trips SET needs_1c_update_at=?, needs_1c_note=?, debt_1c_alert_at=NULL
              WHERE id=?`).run(new Date().toISOString(),
              `ТС: было ${previous.plate} → стало ${vehicle.plate}`, tripId);
          }
          notify('dispatcher', `🔁 Переназначение ТС на заявке №${order.order_no || '—'} ` +
            `(${order.from_point || ''} → ${order.to_point || ''}): ` +
            `новое ТС ${vehicle.plate} ВМЕСТО ${previous.plate}. ` +
            `${previous.entered_1c_at || previous.deferred_1c_at
              ? 'Замените ТС в СУЩЕСТВУЮЩЕМ заказе 1С (не заводите новый — будет дубль) и отметьте «✓ 1С обновлено»'
              : 'Заказ в 1С ещё не вносился — внесите сразу с новым ТС'}`, 'trip', tripId);
        }
      } else {
        db.prepare(`INSERT INTO trips(id,vehicle_id,order_id,customer_name,from_zone_id,to_zone_id,
          from_point,to_point,starts_at,ends_at,distance_km,revenue_vat,status,temperature_mode,
          body_type,cash,order_no,empty_km,created_by,updated_by)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?, 'plan',?,?,?,?,?,?,?)`).run(
          tripId, vehicle.id, order.id, order.customer_name, order.from_zone_id, order.to_zone_id,
          order.from_point || '', order.to_point || '',
          startsAt, endsAt, distance, order.rate_vat, order.temperature_mode, order.body_type,
          Number(order.cash || 0), order.order_no || '', assignEmptyKm, user.id, user.id);
      }
      // Промежуточные пункты заявки становятся стоянками рейса: диспетчер
      // ведёт их в «🧭 Точках» — прибытие, работы, убытие, простой.
      // План прибытия — линейно по цепочке между началом и концом рейса.
      ensureTripStops(db, tripId);
      const existingMiddle = db.prepare(`SELECT COUNT(*) c FROM trip_stops
        WHERE trip_id=? AND seq NOT IN (
          SELECT MIN(seq) FROM trip_stops WHERE trip_id=?
          UNION SELECT MAX(seq) FROM trip_stops WHERE trip_id=?)`)
        .get(tripId, tripId, tripId).c;
      if (orderVia.length && !existingMiddle) {
        const spanMs = Date.parse(endsAt) - Date.parse(startsAt);
        const insertStop = db.prepare(`INSERT INTO trip_stops(id,trip_id,seq,kind,point,
          planned_arrival,updated_by) VALUES(?,?,?,?,?,?,?)`);
        orderVia.forEach((item, index) => {
          const plannedArrival = new Date(Date.parse(startsAt) +
            spanMs * (index + 1) / (orderVia.length + 1)).toISOString();
          insertStop.run(randomUUID(), tripId, index + 2, item.kind, item.point,
            plannedArrival, user.id);
        });
        // Конечная выгрузка после промежуточных: пересчёт порядковых номеров.
        const all = db.prepare(`SELECT id FROM trip_stops WHERE trip_id=?
          ORDER BY CASE WHEN planned_arrival IS NULL THEN 1 ELSE 0 END, planned_arrival`).all(tripId);
        const reseq = db.prepare('UPDATE trip_stops SET seq=? WHERE id=?');
        all.forEach((stop, index) => reseq.run(index + 1, stop.id));
      }
      // Назначение ТС решает и «возврат из плана»: пометка снимается, запись
      // уходит из «Требует решения» по факту решения.
      db.prepare(`UPDATE orders SET status='planned',stage=2,assigned_vehicle_id=?,trip_id=?,
        rejection_reason=NULL,returned_at=NULL,
        stage_changed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(vehicle.id, tripId, order.id);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    // Новый рейс встал в цепочку: у рейсов этой сцепки, назначенных на более
    // поздние даты, подгон теперь считается от другой точки.
    refreshEmptyKm(vehicle.id);
    // Машина получила рейс — её рекомендации по ДРУГИМ заявкам устарели:
    // сбрасываем, сторож пересчитает. Разбор причин замен 03–04.09: 10 из
    // 25 — «предложенное ТС уже назначено на другой рейс».
    invalidateDraftsForVehicle(vehicle.id, order.id);
    queueOutbox(db, 'trips', tripId, order.trip_id ? 'update' : 'create', tripOutboxPayload(tripId),
      integrationPublic().writePolicy === 'automatic');
    return tripId;
  }
  function confirmAssigned(tripId, order, vehicle, user) {
    applyDispatchStep(db, tripId, 'logist_confirm', user.id);
    notify('dispatcher', `Логист назначил и подтвердил рейс ${routeText(order)} (${vehicle.plate}) — подготовьте выход (1С, задание водителю, линия)`, 'trip', tripId);
  }

  match = route(/^\/api\/orders\/([^/]+)\/assign$/, pathname);
  if (match && request.method === 'POST') {
    const user = requirePermission(request, response, 'trips:write');
    if (!user) return;
    const body = await readJson(request);
    const order = db.prepare('SELECT * FROM orders WHERE id=?').get(match[0]);
    const vehicle = db.prepare('SELECT * FROM vehicles WHERE id=?').get(body.vehicleId);
    if (!order) return errorJson(response, 404, 'Заявка не найдена');
    if (!vehicle || vehicle.status !== 'work') return errorJson(response, 422, 'Выберите доступное ТС');
    // Замена рекомендации подбора — только с причиной: иначе «доверие
    // подбору» не разобрать (обоснованная замена или привычка), а причины —
    // сырьё для улучшения правил автоназначения.
    const draft = db.prepare(`SELECT d.vehicle_id, d.empty_km, v.plate FROM assign_drafts d
      JOIN vehicles v ON v.id=d.vehicle_id
      WHERE d.order_id=? AND d.outcome IS NULL`).get(order.id);
    const overrideReason = String(body.overrideReason || '').trim();
    if (draft && draft.vehicle_id !== vehicle.id && !overrideReason) {
      return errorJson(response, 422, `Подбор рекомендует ${draft.plate}${
        draft.empty_km != null ? ` (порожняк ${Math.round(draft.empty_km)} км)` : ''
      } — назначая другое ТС, укажите причину замены`);
    }
    const tripId = assignOrderCore(order, vehicle, user, { distanceKm: body.distanceKm });
    // Итог черновика фиксируем сразу (не дожидаясь сторожа): принял или
    // заменил с причиной.
    if (draft) {
      db.prepare(`UPDATE assign_drafts SET outcome=?, override_reason=?,
        resolved_at=CURRENT_TIMESTAMP WHERE order_id=?`)
        .run(draft.vehicle_id === vehicle.id ? 'accepted' : 'overridden',
          draft.vehicle_id === vehicle.id ? null : overrideReason, order.id);
    }
    // Назначение из вкладки «Логист» подтверждается автоматически (логист
    // назначил сам — подтверждать себя не нужно) и сразу уходит диспетчеру.
    // Назначение из продаж логист обязан подтвердить вручную.
    if (body.autoConfirm) confirmAssigned(tripId, order, vehicle, user);
    audit(db, user, 'assign', 'order', order.id,
      { vehicleId: vehicle.id, tripId, autoConfirm: Boolean(body.autoConfirm),
        ...(draft && draft.vehicle_id !== vehicle.id
          ? { recommendedVehicleId: draft.vehicle_id, overrideReason } : {}) },
      requestIp(request));
    return json(response, 201, { tripId });
  }

  // ── Конструктор маршрутов: кольцевые цепочки заявок от базы до базы ──
  if (request.method === 'POST' && pathname === '/api/routes') {
    const user = requireUser(request, response);
    if (!user) return;
    if (!hasPermission(user, 'orders:write') && !hasPermission(user, 'trips:write')) {
      return errorJson(response, 403, 'Недостаточно прав');
    }
    const body = await readJson(request);
    const orderIds = Array.isArray(body.orderIds) ? body.orderIds.slice(0, 12) : [];
    const id = randomUUID();
    const routeNo = nextRouteNo(db);
    db.prepare(`INSERT INTO routes(id,route_no,base_region,planned_start,target_per_day,comment,
      created_by,updated_by) VALUES(?,?,?,?,?,?,?,?)`).run(
      id, routeNo, String(body.baseRegion || '').slice(0, 80), body.plannedStart || null,
      Number(body.targetPerDay) > 0 ? Number(body.targetPerDay) : 48000,
      String(body.comment || '').slice(0, 500), user.id, user.id);
    const link = db.prepare(`UPDATE orders SET route_id=?,route_seq=?,updated_at=CURRENT_TIMESTAMP
      WHERE id=? AND stage<2 AND (route_id IS NULL OR route_id=?)`);
    orderIds.forEach((orderId, index) => link.run(id, index + 1, orderId, id));
    audit(db, user, 'create', 'route', id, { routeNo, orders: orderIds.length }, requestIp(request));
    return json(response, 201, { id, routeNo });
  }
  match = route(/^\/api\/routes\/([^/]+)\/assign$/, pathname);
  if (match && request.method === 'POST') {
    const user = requirePermission(request, response, 'trips:write');
    if (!user) return;
    const body = await readJson(request);
    const routeRow = db.prepare('SELECT * FROM routes WHERE id=?').get(match[0]);
    const vehicle = db.prepare('SELECT * FROM vehicles WHERE id=?').get(body.vehicleId);
    if (!routeRow) return errorJson(response, 404, 'Маршрут не найден');
    if (!vehicle || vehicle.status !== 'work') return errorJson(response, 422, 'Выберите доступное ТС');
    const routeOrders = db.prepare(`SELECT * FROM orders WHERE route_id=? ORDER BY route_seq`).all(routeRow.id);
    if (!routeOrders.length) return errorJson(response, 422, 'В маршруте нет заявок');
    // Цепочка: каждая следующая заявка стартует не раньше освобождения сцепки
    // после предыдущей и не раньше своего окна.
    let cursor = routeRow.planned_start ? Date.parse(routeRow.planned_start) : 0;
    const tripIds = [];
    for (const order of routeOrders) {
      if (order.stage >= 2 && order.trip_id) {
        const existing = db.prepare('SELECT ends_at FROM trips WHERE id=?').get(order.trip_id);
        if (existing) cursor = Math.max(cursor, Date.parse(existing.ends_at));
        continue;
      }
      const startsAt = new Date(Math.max(Date.parse(order.window_from), cursor || 0)).toISOString();
      const tripId = assignOrderCore(order, vehicle, user, { startsAt });
      confirmAssigned(tripId, order, vehicle, user);
      const created = db.prepare('SELECT ends_at FROM trips WHERE id=?').get(tripId);
      cursor = Date.parse(created.ends_at);
      tripIds.push(tripId);
    }
    db.prepare(`UPDATE routes SET status='assigned',vehicle_id=?,updated_by=?,
      updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(vehicle.id, user.id, routeRow.id);
    audit(db, user, 'assign', 'route', routeRow.id,
      { vehicleId: vehicle.id, trips: tripIds.length }, requestIp(request));
    return json(response, 201, { tripIds });
  }
  // Общий спот-запрос (из Ганта): найти груз на порожний подгон сцепки.
  if (request.method === 'POST' && pathname === '/api/spot-request') {
    const user = requireUser(request, response);
    if (!user) return;
    if (!hasPermission(user, 'orders:write') && !hasPermission(user, 'trips:write')) {
      return errorJson(response, 403, 'Недостаточно прав');
    }
    const body = await readJson(request);
    const fromRegion = String(body.fromRegion || '').slice(0, 80);
    const toRegion = String(body.toRegion || '').slice(0, 80);
    if (!fromRegion || !toRegion) return errorJson(response, 422, 'Нужны fromRegion и toRegion');
    const plate = String(body.vehiclePlate || '').slice(0, 20);
    const around = body.aroundIso ? ` к ${new Date(body.aroundIso).toLocaleString('ru-RU',
      { day: 'numeric', month: 'short', timeZone: 'Europe/Moscow' })}` : '';
    const km = Number(body.km) ? ` (~${Math.round(Number(body.km))} км порожним)` : '';
    notify('sales', `🔍 Спот из Ганта${plate ? ` (${plate})` : ''}: нужен груз ${fromRegion} → ${toRegion}${around}${km} — закройте порожний подгон`, 'vehicle', body.vehicleId || null);
    audit(db, user, 'spot-request', 'vehicle', String(body.vehicleId || ''), { fromRegion, toRegion }, requestIp(request));
    return json(response, 200, { ok: true });
  }
  // Спот-запрос пустого плеча: конструктор просит продажи найти груз
  // на порожний перегон маршрута — сообщение уходит роли «Продажи».
  // ── Споты маршрута: плечо без заявки как полноценное звено цепочки.
  // Дата берётся из расчёта маршрута («машина будет здесь тогда-то»),
  // а не из наличия заявок — продажи продают под слот маршрута.
  match = route(/^\/api\/routes\/([^/]+)\/spots$/, pathname);
  if (match && request.method === 'POST') {
    const user = requireUser(request, response);
    if (!user) return;
    if (!hasPermission(user, 'orders:write') && !hasPermission(user, 'trips:write')) {
      return errorJson(response, 403, 'Недостаточно прав');
    }
    const routeRow = db.prepare('SELECT * FROM routes WHERE id=?').get(match[0]);
    if (!routeRow) return errorJson(response, 404, 'Маршрут не найден');
    const body = await readJson(request);
    const id = randomUUID();
    db.prepare(`INSERT INTO route_spots(id,route_id,seq,from_zone_id,to_zone_id,from_label,to_label,
        planned_load,planned_unload,expected_rate,expected_km,candidates,kind,created_by)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, routeRow.id, Number(body.seq) || 0,
      body.fromZoneId || null, body.toZoneId || null,
      String(body.fromLabel || '').slice(0, 120), String(body.toLabel || '').slice(0, 120),
      body.plannedLoad || null, body.plannedUnload || null,
      Number(body.expectedRate) || 0, Number(body.expectedKm) || 0,
      String(body.candidates || '').slice(0, 300),
      body.kind === 'attach' ? 'attach' : 'sell', user.id);
    audit(db, user, 'create', 'route-spot', id,
      { routeNo: routeRow.route_no, from: body.fromLabel, to: body.toLabel }, requestIp(request));
    return json(response, 201, { id });
  }
  // Смена вида плеча: «в продажу» (sell — задание продажам найти груз) или
  // обратно «плечо сетки» (attach — закрывает логист). Кнопка «→ Продажи»
  // в редакторе раньше слала только сообщение в чат — задание не рождалось.
  match = route(/^\/api\/routes\/([^/]+)\/spots\/([^/]+)$/, pathname);
  if (match && request.method === 'PATCH') {
    const user = requireUser(request, response);
    if (!user) return;
    if (!hasPermission(user, 'orders:write') && !hasPermission(user, 'trips:write')) {
      return errorJson(response, 403, 'Недостаточно прав');
    }
    const body = await readJson(request);
    const kind = body.kind === 'attach' ? 'attach' : 'sell';
    const done = db.prepare(`UPDATE route_spots SET kind=?, updated_at=CURRENT_TIMESTAMP
      WHERE id=? AND route_id=?`).run(kind, match[1], match[0]);
    if (!done.changes) return errorJson(response, 404, 'Спот не найден');
    audit(db, user, 'update', 'route-spot', match[1], { kind }, requestIp(request));
    return json(response, 200, { ok: true });
  }
  match = route(/^\/api\/routes\/([^/]+)\/spots\/([^/]+)$/, pathname);
  if (match && request.method === 'DELETE') {
    const user = requireUser(request, response);
    if (!user) return;
    if (!hasPermission(user, 'orders:write') && !hasPermission(user, 'trips:write')) {
      return errorJson(response, 403, 'Недостаточно прав');
    }
    db.prepare('DELETE FROM route_spots WHERE id=? AND route_id=?').run(match[1], match[0]);
    audit(db, user, 'delete', 'route-spot', match[1], {}, requestIp(request));
    return json(response, 200, { ok: true });
  }
  // Спот закрыт заявкой: продажи продали груз — привязываем заявку к маршруту.
  match = route(/^\/api\/routes\/([^/]+)\/spots\/([^/]+)\/close$/, pathname);
  if (match && request.method === 'POST') {
    const user = requireUser(request, response);
    if (!user) return;
    if (!hasPermission(user, 'orders:write') && !hasPermission(user, 'trips:write')) {
      return errorJson(response, 403, 'Недостаточно прав');
    }
    const body = await readJson(request);
    const spot = db.prepare('SELECT * FROM route_spots WHERE id=? AND route_id=?').get(match[1], match[0]);
    if (!spot) return errorJson(response, 404, 'Спот не найден');
    const order = db.prepare(`SELECT id FROM orders WHERE id=? AND stage<2 AND deleted_at IS NULL
      AND (route_id IS NULL OR route_id=?)`).get(String(body.orderId || ''), match[0]);
    if (!order) return errorJson(response, 422, 'Заявка занята или не найдена');
    db.prepare(`UPDATE orders SET route_id=?,route_seq=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(match[0], spot.seq, order.id);
    db.prepare(`UPDATE route_spots SET status='closed', order_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(order.id, spot.id);
    audit(db, user, 'close', 'route-spot', spot.id, { orderId: order.id }, requestIp(request));
    return json(response, 200, { ok: true });
  }

  match = route(/^\/api\/routes\/([^/]+)\/spot-request$/, pathname);
  if (match && request.method === 'POST') {
    const user = requireUser(request, response);
    if (!user) return;
    if (!hasPermission(user, 'orders:write') && !hasPermission(user, 'trips:write')) {
      return errorJson(response, 403, 'Недостаточно прав');
    }
    const routeRow = db.prepare('SELECT * FROM routes WHERE id=?').get(match[0]);
    if (!routeRow) return errorJson(response, 404, 'Маршрут не найден');
    const body = await readJson(request);
    const fromRegion = String(body.fromRegion || '').slice(0, 80);
    const toRegion = String(body.toRegion || '').slice(0, 80);
    if (!fromRegion || !toRegion) return errorJson(response, 422, 'Нужны fromRegion и toRegion');
    const around = body.aroundIso ? ` к ${new Date(body.aroundIso).toLocaleString('ru-RU',
      { day: 'numeric', month: 'short', timeZone: 'Europe/Moscow' })}` : '';
    const km = Number(body.km) ? ` (~${Math.round(Number(body.km))} км порожним)` : '';
    notify('sales', `🔍 Спот из конструктора ${routeRow.route_no}: нужен груз ${fromRegion} → ${toRegion}${around}${km} — закройте пустое плечо маршрута`, 'route', routeRow.id);
    audit(db, user, 'spot-request', 'route', routeRow.id, { fromRegion, toRegion }, requestIp(request));
    return json(response, 200, { ok: true });
  }
  match = route(/^\/api\/routes\/([^/]+)$/, pathname);
  if (match && request.method === 'PATCH') {
    const user = requireUser(request, response);
    if (!user) return;
    if (!hasPermission(user, 'orders:write') && !hasPermission(user, 'trips:write')) {
      return errorJson(response, 403, 'Недостаточно прав');
    }
    const body = await readJson(request);
    const routeRow = db.prepare('SELECT * FROM routes WHERE id=?').get(match[0]);
    if (!routeRow) return errorJson(response, 404, 'Маршрут не найден');
    if (Array.isArray(body.orderIds)) {
      db.prepare(`UPDATE orders SET route_id=NULL,route_seq=NULL WHERE route_id=?`).run(routeRow.id);
      const link = db.prepare(`UPDATE orders SET route_id=?,route_seq=?,updated_at=CURRENT_TIMESTAMP
        WHERE id=? AND stage<2 AND route_id IS NULL`);
      body.orderIds.slice(0, 12).forEach((orderId, index) => link.run(routeRow.id, index + 1, orderId));
    }
    const status = ['draft', 'handed', 'done', 'cancelled'].includes(body.status)
      ? body.status : routeRow.status;
    db.prepare(`UPDATE routes SET status=?,planned_start=?,target_per_day=?,base_region=?,comment=?,
      updated_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(
      status, body.plannedStart ?? routeRow.planned_start,
      Number(body.targetPerDay) > 0 ? Number(body.targetPerDay) : routeRow.target_per_day,
      body.baseRegion != null ? String(body.baseRegion).slice(0, 80) : routeRow.base_region,
      body.comment != null ? String(body.comment).slice(0, 500) : routeRow.comment,
      user.id, routeRow.id);
    if (status === 'handed' && routeRow.status === 'draft') {
      notify('logist', `Продажи передали маршрут ${routeRow.route_no}: назначьте ТС в «Конструкторе»`, 'route', routeRow.id);
    }
    audit(db, user, 'update', 'route', routeRow.id, { status }, requestIp(request));
    return json(response, 200, { ok: true });
  }
  if (match && request.method === 'DELETE') {
    const user = requireUser(request, response);
    if (!user) return;
    if (!hasPermission(user, 'orders:write') && !hasPermission(user, 'trips:write')) {
      return errorJson(response, 403, 'Недостаточно прав');
    }
    const routeRow = db.prepare('SELECT * FROM routes WHERE id=?').get(match[0]);
    if (!routeRow) return errorJson(response, 404, 'Маршрут не найден');
    db.prepare(`UPDATE orders SET route_id=NULL,route_seq=NULL WHERE route_id=?`).run(routeRow.id);
    db.prepare('DELETE FROM routes WHERE id=?').run(routeRow.id);
    audit(db, user, 'delete', 'route', routeRow.id, {}, requestIp(request));
    return json(response, 200, { ok: true });
  }

  // ── Справочник водителей: закрепление за сцепками, отпуска/болезни ──
  if (request.method === 'GET' && pathname === '/api/drivers') {
    const user = requirePermission(request, response, 'planner:read');
    if (!user) return;
    return json(response, 200, {
      items: db.prepare(`SELECT d.*,v.plate vehicle_plate FROM drivers d
        LEFT JOIN vehicles v ON v.id=d.vehicle_id
        WHERE d.status<>'fired' ORDER BY d.full_name`).all()
    });
  }
  if (request.method === 'POST' && pathname === '/api/drivers') {
    const user = requirePermission(request, response, 'fleet:write');
    if (!user) return;
    const body = await readJson(request);
    const name = String(body.fullName || '').trim();
    if (!name) return errorJson(response, 422, 'Укажите ФИО водителя');
    const id = randomUUID();
    const shift = parseShift(body);
    db.prepare(`INSERT INTO drivers(id,full_name,phone,note,shift_on,shift_off,shift_anchor)
      VALUES(?,?,?,?,?,?,?)`).run(
      id, name, String(body.phone || '').trim(), String(body.note || '').trim(),
      shift.on, shift.off, shift.anchor);
    audit(db, user, 'create', 'driver', id, body, requestIp(request));
    return json(response, 201, { id });
  }
  // Уволенные видны только в справочнике (раздел «Уволенные») — для
  // восстановления случайно удалённых (кейс Иванов/Евсеев 19.08).
  if (request.method === 'GET' && pathname === '/api/drivers/fired') {
    const user = requirePermission(request, response, 'planner:read');
    if (!user) return;
    // Дубли не показываем: если полный тёзка работает под другой записью
    // (массовая загрузка 05.08 создала двойников), «восстановление» дубля
    // лишь задвоит человека — кейс Евсеев/Иванов/Бажко.
    return json(response, 200, { items: db.prepare(`SELECT id, full_name, phone, updated_at
      FROM drivers d WHERE status='fired'
        AND NOT EXISTS (SELECT 1 FROM drivers a WHERE a.status<>'fired'
          AND TRIM(a.full_name)=TRIM(d.full_name))
      ORDER BY full_name`).all() });
  }
  match = route(/^\/api\/drivers\/([^/]+)\/restore$/, pathname);
  if (match && request.method === 'POST') {
    const user = requirePermission(request, response, 'fleet:write');
    if (!user) return;
    const driver = db.prepare(`SELECT * FROM drivers WHERE id=? AND status='fired'`).get(match[0]);
    if (!driver) return errorJson(response, 404, 'Уволенный водитель не найден');
    // Полный тёзка уже в строю — восстановление создаст задвоение (кейс
    // Бажко: удалили и завели заново): работать надо с активной записью.
    const twin = db.prepare(`SELECT 1 FROM drivers WHERE status<>'fired' AND TRIM(full_name)=TRIM(?)`)
      .get(driver.full_name);
    if (twin) return errorJson(response, 409,
      `«${driver.full_name}» уже есть среди работающих — это дубль, восстановление создаст задвоение. Работайте с активной записью`);
    db.prepare(`UPDATE drivers SET status='active', updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(driver.id);
    // Если ФИО уже стоит в карточке работающего ТС (кейс Евсеева: числился
    // уволенным, а машина в рейсе) — сразу возвращаем и закрепление,
    // не занимая сцепку другого активного водителя.
    const vehicle = db.prepare(`SELECT v.id, v.plate FROM vehicles v
      WHERE v.status='work' AND TRIM(COALESCE(v.driver_name,''))=TRIM(?)
        AND NOT EXISTS (SELECT 1 FROM drivers d2 WHERE d2.status<>'fired' AND d2.vehicle_id=v.id)
      LIMIT 1`).get(driver.full_name);
    if (vehicle) db.prepare(`UPDATE drivers SET vehicle_id=? WHERE id=?`).run(vehicle.id, driver.id);
    audit(db, user, 'restore', 'driver', driver.id,
      { fullName: driver.full_name, vehicle: vehicle?.plate || null }, requestIp(request));
    return json(response, 200, { ok: true, vehiclePlate: vehicle?.plate || null });
  }
  match = route(/^\/api\/drivers\/([^/]+)\/card$/, pathname);
  if (match && request.method === 'GET') {
    const user = requirePermission(request, response, 'planner:read');
    if (!user) return;
    return json(response, 200, { reasons: ABSENCE_REASONS, ...driverCardData(db, match[0]) });
  }
  match = route(/^\/api\/drivers\/([^/]+)$/, pathname);
  if (match && request.method === 'PATCH') {
    const user = requirePermission(request, response, 'fleet:write');
    if (!user) return;
    const body = await readJson(request);
    const current = db.prepare('SELECT * FROM drivers WHERE id=?').get(match[0]);
    if (!current) return errorJson(response, 404, 'Водитель не найден');
    const vehicleId = 'vehicleId' in body ? (body.vehicleId || null) : current.vehicle_id;
    const status = body.status ?? current.status;
    if (!['active', 'vacation', 'sick', 'fired'].includes(status)) {
      return errorJson(response, 422, 'Некорректный статус водителя');
    }
    const absentFrom = 'absentFrom' in body ? (body.absentFrom || null) : current.absent_from;
    const absentTo = 'absentTo' in body ? (body.absentTo || null) : current.absent_to;
    db.exec('BEGIN IMMEDIATE');
    try {
      // Перезакрепление: имя водителя — витрина на карточке ТС.
      if (vehicleId !== current.vehicle_id) {
        if (current.vehicle_id) {
          db.prepare(`UPDATE vehicles SET driver_name='',updated_at=CURRENT_TIMESTAMP
            WHERE id=? AND driver_name=?`).run(current.vehicle_id, current.full_name);
        }
        if (vehicleId) {
          // Сцепка занята другим водителем? Прежний открепляется.
          db.prepare(`UPDATE drivers SET vehicle_id=NULL,updated_at=CURRENT_TIMESTAMP
            WHERE vehicle_id=? AND id<>?`).run(vehicleId, match[0]);
          db.prepare(`UPDATE vehicles SET driver_name=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
            .run(String(body.fullName ?? current.full_name).trim(), vehicleId);
        }
      } else if (body.fullName && vehicleId) {
        db.prepare(`UPDATE vehicles SET driver_name=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
          .run(String(body.fullName).trim(), vehicleId);
      }
      const shift = 'shiftOn' in body || 'shiftOff' in body || 'shiftAnchor' in body
        ? parseShift(body)
        : { on: current.shift_on, off: current.shift_off, anchor: current.shift_anchor };
      db.prepare(`UPDATE drivers SET full_name=?,phone=?,status=?,vehicle_id=?,
        absent_from=?,absent_to=?,note=?,shift_on=?,shift_off=?,shift_anchor=?,
        updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(
        String(body.fullName ?? current.full_name).trim(),
        String(body.phone ?? current.phone).trim(), status, vehicleId,
        absentFrom, absentTo, String(body.note ?? current.note).trim(),
        shift.on, shift.off, shift.anchor, match[0]);
      // Отпуск/болезнь с датами: закреплённая сцепка получает интервал
      // «без водителя» — календарь, потребность и задания видят это сразу.
      if (['vacation', 'sick'].includes(status) && vehicleId && absentFrom && absentTo &&
          Date.parse(absentTo) > Date.parse(absentFrom)) {
        const exists = db.prepare(`SELECT 1 FROM vehicle_dispositions
          WHERE vehicle_id=? AND kind='no_driver' AND starts_at=? AND ends_at=?`)
          .get(vehicleId, absentFrom, absentTo);
        if (!exists) {
          db.prepare(`INSERT INTO vehicle_dispositions(id,vehicle_id,kind,starts_at,ends_at,note,created_by)
            VALUES(?,?,?,?,?,?,?)`).run(randomUUID(), vehicleId, 'no_driver', absentFrom, absentTo,
            `${status === 'vacation' ? 'Отпуск' : 'Больничный'}: ${current.full_name}`, user.id);
          // Машина стала недоступной — рекомендации автоподбора с ней устарели
          // (кейс р894ху58: пересменку внесли после расчёта черновика, логист
          // менял рекомендацию руками с причиной «пересменка»).
          invalidateDraftsForVehicle(vehicleId);
        }
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    audit(db, user, 'update', 'driver', match[0], body, requestIp(request));
    return json(response, 200, { ok: true });
  }
  if (match && request.method === 'DELETE') {
    const user = requirePermission(request, response, 'fleet:write');
    if (!user) return;
    const current = db.prepare('SELECT * FROM drivers WHERE id=?').get(match[0]);
    if (!current) return errorJson(response, 404, 'Водитель не найден');
    // Мягко: увольнение, а не удаление — история сохраняется.
    db.exec('BEGIN IMMEDIATE');
    try {
      if (current.vehicle_id) {
        db.prepare(`UPDATE vehicles SET driver_name='',updated_at=CURRENT_TIMESTAMP
          WHERE id=? AND driver_name=?`).run(current.vehicle_id, current.full_name);
      }
      db.prepare(`UPDATE drivers SET status='fired',vehicle_id=NULL,updated_at=CURRENT_TIMESTAMP
        WHERE id=?`).run(match[0]);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    audit(db, user, 'delete', 'driver', match[0], { soft: true }, requestIp(request));
    return json(response, 200, { ok: true });
  }

  // Прицеп уникален: сохранение карточки ТС с прицепом, который висит на
  // другом тягаче, отклоняется — иначе прицеп числился за двумя ТС и
  // подсвечивался в Ганте дважды. Перестановка — только через «🔗 Перецепку».
  function trailerConflict(trailerPlate, exceptVehicleId) {
    const plate = String(trailerPlate || '').trim();
    if (!plate || plate.toLowerCase() === 'без прицепа') return null;
    return db.prepare(`SELECT plate FROM vehicles
      WHERE TRIM(COALESCE(trailer_plate,''))=? AND id<>?`).get(plate, exceptVehicleId || '');
  }

  if (request.method === 'POST' && pathname === '/api/vehicles') {
    const user = requirePermission(request, response, 'fleet:write');
    if (!user) return;
    const body = await readJson(request);
    if (!body.plate || !body.typeId) return errorJson(response, 422, 'Номер и тип обязательны');
    const conflict = trailerConflict(body.trailerPlate, null);
    if (conflict) return errorJson(response, 409,
      `Прицеп ${String(body.trailerPlate).trim()} уже закреплён за ${conflict.plate} — перецепите через «Ресурс → 🔗 Перецепка»`);
    const id = randomUUID();
    db.prepare(`INSERT INTO vehicles(id,plate,trailer_plate,type_id,driver_name,zone_id,status)
      VALUES(?,?,?,?,?,?,?)`).run(
      id, body.plate.trim(), body.trailerPlate || '', body.typeId, body.driverName || '',
      body.zoneId || null, body.status || 'work');
    audit(db, user, 'create', 'vehicle', id, body, requestIp(request));
    return json(response, 201, { id });
  }

  match = route(/^\/api\/vehicles\/([^/]+)$/, pathname);
  if (match && request.method === 'PATCH') {
    const user = requirePermission(request, response, 'fleet:write');
    if (!user) return;
    const body = await readJson(request);
    const current = db.prepare('SELECT * FROM vehicles WHERE id=?').get(match[0]);
    if (!current) return errorJson(response, 404, 'ТС не найдено');
    if (body.trailerPlate !== undefined) {
      const conflict = trailerConflict(body.trailerPlate, match[0]);
      if (conflict) return errorJson(response, 409,
        `Прицеп ${String(body.trailerPlate).trim()} уже закреплён за ${conflict.plate} — перецепите через «Ресурс → 🔗 Перецепка»`);
    }
    db.prepare(`UPDATE vehicles SET plate=?,trailer_plate=?,type_id=?,driver_name=?,zone_id=?,status=?,
      unavailable_from=?,unavailable_to=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(
      body.plate ?? current.plate, body.trailerPlate ?? current.trailer_plate,
      body.typeId ?? current.type_id, body.driverName ?? current.driver_name,
      body.zoneId ?? current.zone_id, body.status ?? current.status,
      body.unavailableFrom ?? current.unavailable_from, body.unavailableTo ?? current.unavailable_to,
      match[0]);
    // Смена водителя из карточки/справочника ТС синхронизирует справочник
    // водителей: имя ищется без учёта регистра, новый — создаётся и
    // закрепляется, прежний водитель этой сцепки открепляется.
    const newDriver = String(body.driverName ?? '').trim();
    if ('driverName' in body && newDriver !== String(current.driver_name || '').trim()) {
      db.prepare(`UPDATE drivers SET vehicle_id=NULL,updated_at=CURRENT_TIMESTAMP
        WHERE vehicle_id=?`).run(match[0]);
      if (newDriver) {
        const existing = db.prepare(`SELECT id FROM drivers
          WHERE full_name=? COLLATE NOCASE AND status<>'fired'`).get(newDriver);
        if (existing) {
          db.prepare(`UPDATE drivers SET vehicle_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
            .run(match[0], existing.id);
        } else {
          db.prepare(`INSERT INTO drivers(id,full_name,vehicle_id) VALUES(?,?,?)`)
            .run(randomUUID(), newDriver, match[0]);
        }
      }
    }
    audit(db, user, 'update', 'vehicle', match[0], body, requestIp(request));
    return json(response, 200, { ok: true });
  }
  // Запрос загрузки от ресурсника: адресное авто-сообщение продажам
  // с местом и временем доступности сцепки — замыкает задание ресурса.
  match = route(/^\/api\/vehicles\/([^/]+)\/request-load$/, pathname);
  if (match && request.method === 'POST') {
    // Запросить загрузку может и ресурсник, и логист — у каждого своё право.
    const actor = currentUser(request);
    const permission = hasPermission(actor, 'fleet:write') ? 'fleet:write' : 'trips:write';
    const user = requirePermission(request, response, permission);
    if (!user) return;
    const vehicle = db.prepare(`SELECT v.*,vt.name type_name FROM vehicles v
      JOIN vehicle_types vt ON vt.id=v.type_id WHERE v.id=?`).get(match[0]);
    if (!vehicle) return errorJson(response, 404, 'ТС не найдено');
    const lastTrip = db.prepare(`SELECT t.ends_at,z.name to_name FROM trips t
      JOIN zones z ON z.id=t.to_zone_id
      WHERE t.vehicle_id=? AND t.status<>'rejected' ORDER BY t.ends_at DESC LIMIT 1`).get(match[0]);
    const zoneName = lastTrip?.to_name ||
      db.prepare('SELECT name FROM zones WHERE id=?').get(vehicle.zone_id)?.name || 'зона приписки';
    notify('sales', `Запрос загрузки: сцепка ${vehicle.plate} (${vehicle.type_name}) свободна в «${zoneName}»${lastTrip ? ` с ${lastTrip.ends_at.slice(0, 10)}` : ''} — подберите заявку в «Потребности от логистики»`, 'vehicle', match[0]);
    audit(db, user, 'request_load', 'vehicle', match[0], {}, requestIp(request));
    return json(response, 200, { ok: true });
  }

  // Заявка принята в зону, где сейчас нет свободных машин: логисту нужно
  // спланировать перегон или освободить сцепку — иначе окно закроется без ТС.
  if (request.method === 'POST' && pathname === '/api/notify-capacity') {
    const user = requirePermission(request, response, 'orders:write');
    if (!user) return;
    const body = await readJson(request);
    const order = db.prepare(`SELECT o.*, f.name from_name, t.name to_name FROM orders o
      LEFT JOIN zones f ON f.id=o.from_zone_id LEFT JOIN zones t ON t.id=o.to_zone_id
      WHERE o.id=?`).get(body.orderId);
    if (!order) return errorJson(response, 404, 'Заявка не найдена');
    notify('logist', `🚧 Заявка ${order.order_no ? `№ ${order.order_no} ` : ''}${order.customer_name}: ` +
      `${routeText(order)}, погрузка ${String(order.window_from).slice(0, 16).replace('T', ' ')} — ` +
      `в зоне «${clean(body.zone) || order.from_name}» свободных машин нет. ` +
      `Нужен перегон порожним или освобождение сцепки`, 'order', order.id);
    audit(db, user, 'capacity-alert', 'order', order.id, { zone: body.zone }, requestIp(request));
    return json(response, 200, { ok: true });
  }

  // ── Проект «160 млн»: развитие продукта с измеримым эффектом ──
  // Экран руководителя: где стоит время между ролями, сколько действий
  // стоит работа, что мы меняем и что это дало.
  if (request.method === 'GET' && pathname === '/api/project160') {
    const user = requirePermission(request, response, 'reports:read');
    if (!user) return;
    const monthStart = url.searchParams.get('from')
      || new Date().toISOString().slice(0, 8) + '01';
    const next = new Date(Date.parse(`${monthStart}T00:00:00Z`));
    next.setUTCMonth(next.getUTCMonth() + 1);
    const monthEnd = url.searchParams.get('to') || next.toISOString().slice(0, 10);
    return json(response, 200, {
      period: { from: monthStart, to: monthEnd },
      handoffs: handoffMetrics(db, monthStart, monthEnd),
      operations: operationMetrics(db, monthStart, monthEnd),
      money: moneyMetrics(db, monthStart, monthEnd),
      initiatives: listInitiatives(db, monthStart, monthEnd),
      metrics: METRICS,
      snapshots: listSnapshots(db)
    });
  }
  if (request.method === 'POST' && pathname === '/api/project160/initiatives') {
    const user = requirePermission(request, response, 'reports:read');
    if (!user) return;
    const body = await readJson(request);
    if (!clean(body.title)) return errorJson(response, 422, 'Опишите инициативу');
    const id = randomUUID();
    db.prepare(`INSERT INTO project_initiatives(id,title,area,baseline,target,effect_rub,
        status,sort_order,metric_key,metric_target,owner_side,created_by)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, clean(body.title).slice(0, 200), clean(body.area).slice(0, 60),
      clean(body.baseline).slice(0, 160), clean(body.target).slice(0, 160),
      Number(body.effectRub) || 0, ['todo', 'doing'].includes(body.status) ? body.status : 'todo',
      Number(body.sortOrder) || 0,
      METRICS[body.metricKey] ? body.metricKey : '',
      Number.isFinite(Number(body.metricTarget)) ? Number(body.metricTarget) : null,
      ['team', 'product'].includes(body.ownerSide) ? body.ownerSide : 'team', user.id);
    audit(db, user, 'create', 'initiative', id, { title: body.title }, requestIp(request));
    return json(response, 201, { id });
  }
  match = route(/^\/api\/project160\/initiatives\/([^/]+)$/, pathname);
  if (match && request.method === 'PATCH') {
    const user = requirePermission(request, response, 'reports:read');
    if (!user) return;
    const body = await readJson(request);
    const current = db.prepare('SELECT * FROM project_initiatives WHERE id=?').get(match[0]);
    if (!current) return errorJson(response, 404, 'Инициатива не найдена');
    const status = ['todo', 'doing', 'done', 'dropped'].includes(body.status)
      ? body.status : current.status;
    db.prepare(`UPDATE project_initiatives SET status=?, result=?, effect_rub=?,
        done_at=CASE WHEN ?='done' AND done_at IS NULL THEN CURRENT_TIMESTAMP
          WHEN ?<>'done' THEN NULL ELSE done_at END,
        updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(
      status, body.result !== undefined ? clean(body.result).slice(0, 400) : current.result,
      body.effectRub !== undefined ? Number(body.effectRub) || 0 : current.effect_rub,
      status, status, match[0]);
    audit(db, user, 'update', 'initiative', match[0], { status }, requestIp(request));
    return json(response, 200, { ok: true });
  }
  match = route(/^\/api\/project160\/initiatives\/([^/]+)$/, pathname);
  if (match && request.method === 'DELETE') {
    const user = requirePermission(request, response, 'reports:read');
    if (!user) return;
    db.prepare('DELETE FROM project_initiatives WHERE id=?').run(match[0]);
    audit(db, user, 'delete', 'initiative', match[0], {}, requestIp(request));
    return json(response, 200, { ok: true });
  }
  if (request.method === 'POST' && pathname === '/api/project160/snapshot') {
    const user = requirePermission(request, response, 'reports:read');
    if (!user) return;
    const body = await readJson(request);
    const from = body.from || new Date().toISOString().slice(0, 8) + '01';
    const next = new Date(Date.parse(`${from}T00:00:00Z`));
    next.setUTCMonth(next.getUTCMonth() + 1);
    const snapshot = takeSnapshot(db, { label: body.label, fromIso: from,
      toIso: body.to || next.toISOString().slice(0, 10), userId: user.id });
    audit(db, user, 'create', 'project_snapshot', snapshot.id, { label: body.label }, requestIp(request));
    return json(response, 201, snapshot);
  }

  // ── Справочник точек сервиса: мойка, шиномонтаж, стоянка, заправка ──
  if (request.method === 'GET' && pathname === '/api/service-points') {
    const user = requireUser(request, response);
    if (!user) return;
    return json(response, 200, {
      items: db.prepare('SELECT * FROM service_points ORDER BY kind,name').all()
    });
  }
  if (request.method === 'POST' && pathname === '/api/service-points') {
    const user = requirePermission(request, response, 'fleet:write');
    if (!user) return;
    const body = await readJson(request);
    const kinds = ['wash', 'service', 'tire', 'parking', 'fuel', 'rest'];
    if (!clean(body.name) || !kinds.includes(body.kind)) {
      return errorJson(response, 422, 'Название и вид точки обязательны');
    }
    const id = randomUUID();
    db.prepare(`INSERT INTO service_points(id,kind,name,address,region,latitude,longitude,
        phone,work_hours,note,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, body.kind, clean(body.name).slice(0, 160), clean(body.address).slice(0, 240),
      clean(body.region).slice(0, 120),
      Number.isFinite(Number(body.latitude)) ? Number(body.latitude) : null,
      Number.isFinite(Number(body.longitude)) ? Number(body.longitude) : null,
      phonePretty(body.phone || ''), clean(body.workHours).slice(0, 120),
      clean(body.note).slice(0, 300), user.id);
    audit(db, user, 'create', 'service_point', id, { name: body.name, kind: body.kind }, requestIp(request));
    return json(response, 201, { id });
  }
  match = route(/^\/api\/service-points\/([^/]+)$/, pathname);
  if (match && request.method === 'DELETE') {
    const user = requirePermission(request, response, 'fleet:write');
    if (!user) return;
    db.prepare('DELETE FROM service_points WHERE id=?').run(match[0]);
    audit(db, user, 'delete', 'service_point', match[0], {}, requestIp(request));
    return json(response, 200, { ok: true });
  }
  // Настройки телефонии с токеном — только администратору настроек.
  if (request.method === 'GET' && pathname === '/api/telephony/config') {
    const user = requirePermission(request, response, 'settings:write');
    if (!user) return;
    const telephony = settingsObject(db).telephony || {};
    return json(response, 200, {
      enabled: Boolean(telephony.enabled), provider: telephony.provider || '',
      token: telephony.token || '', popup: telephony.popup !== false,
      webhookUrl: '/api/telephony/webhook'
    });
  }

  // ── Телефония: вебхук АТС и карточка звонящего ──
  // Приём событий работает и до подключения АТС: пока звонки заводятся
  // вручную кнопкой «Звонок водителя», после интеграции те же записи придут
  // от провайдера. Вебхук защищён токеном из настроек — без него ничего
  // не принимается, чтобы посторонний не поднимал карточки сотрудникам.
  if (request.method === 'POST' && pathname === '/api/telephony/webhook') {
    const telephony = settingsObject(db).telephony || {};
    const token = String(request.headers['x-telephony-token'] || '');
    if (!telephony.enabled) return errorJson(response, 409, 'Телефония выключена в настройках');
    if (!telephony.token || token !== telephony.token) {
      return errorJson(response, 401, 'Неверный токен телефонии');
    }
    const body = await readJson(request);
    const fromPhone = String(body.from || body.caller || '');
    const digits = phoneDigits(fromPhone);
    if (!digits) return errorJson(response, 422, 'В событии нет номера звонящего');
    const caller = identifyCaller(db, fromPhone);
    const targetUser = body.to
      ? db.prepare(`SELECT id FROM users WHERE deleted_at IS NULL AND phone<>'' AND
          REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone,'+',''),'-',''),' ',''),'(',''),')','') LIKE ?
          LIMIT 1`).get(`%${phoneDigits(body.to)}`)?.id || null
      : null;
    const id = randomUUID();
    try {
      db.prepare(`INSERT INTO call_events(id,provider,external_id,direction,from_phone,to_phone,
          from_digits,matched_kind,matched_id,matched_name,vehicle_id,target_user_id,started_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        id, String(body.provider || telephony.provider || 'ats').slice(0, 40),
        body.callId ? String(body.callId).slice(0, 120) : null,
        body.direction === 'out' ? 'out' : 'in', fromPhone, String(body.to || ''), digits,
        caller.kind, caller.id, caller.name, caller.vehicleId, targetUser,
        Number.isFinite(Date.parse(body.at)) ? new Date(Date.parse(body.at)).toISOString()
          : new Date().toISOString());
    } catch (error) {
      // Повторная доставка того же события — не ошибка интеграции.
      if (String(error.message).includes('UNIQUE')) return json(response, 200, { ok: true, duplicate: true });
      throw error;
    }
    return json(response, 201, { id, caller: caller.kind, name: caller.name });
  }
  // Свежие входящие: интерфейс опрашивает раз в несколько секунд и поднимает
  // карточку. Отдаём только неразобранные звонки за последние 5 минут.
  if (request.method === 'GET' && pathname === '/api/telephony/incoming') {
    const user = requireUser(request, response);
    if (!user) return;
    const since = new Date(Date.now() - 5 * 60_000).toISOString();
    const items = db.prepare(`SELECT c.*, v.plate vehicle_plate FROM call_events c
      LEFT JOIN vehicles v ON v.id=c.vehicle_id
      WHERE c.direction='in' AND c.handled_at IS NULL AND c.started_at>=?
        AND (c.target_user_id IS NULL OR c.target_user_id=?)
      ORDER BY c.started_at DESC LIMIT 5`).all(since, user.id);
    return json(response, 200, { items });
  }
  match = route(/^\/api\/telephony\/calls\/([^/]+)\/handled$/, pathname);
  if (match && request.method === 'POST') {
    const user = requireUser(request, response);
    if (!user) return;
    db.prepare(`UPDATE call_events SET handled_by=?,handled_at=CURRENT_TIMESTAMP
      WHERE id=? AND handled_at IS NULL`).run(user.id, match[0]);
    return json(response, 200, { ok: true });
  }
  // Карточка звонящего: всё, чем можно ответить водителю, одним запросом —
  // где машина, что за задание, следующее, контакты и ближайшие сервисы.
  if (request.method === 'GET' && pathname === '/api/call-card') {
    const user = requireUser(request, response);
    if (!user) return;
    const phone = url.searchParams.get('phone') || '';
    const caller = phone ? identifyCaller(db, phone) : null;
    const vehicleId = url.searchParams.get('vehicleId') || caller?.vehicleId || '';
    const vehicle = vehicleId
      ? db.prepare(`SELECT v.*, vt.name type_name, z.name zone_name FROM vehicles v
          JOIN vehicle_types vt ON vt.id=v.type_id LEFT JOIN zones z ON z.id=v.zone_id
          WHERE v.id=?`).get(vehicleId) : null;
    if (!vehicle) {
      return json(response, 200, { caller, vehicle: null, contacts: employeeContacts() });
    }
    const nowIso = new Date().toISOString();
    const active = db.prepare(`SELECT t.*, f.name from_name, d.name to_name FROM trips t
      JOIN zones f ON f.id=t.from_zone_id JOIN zones d ON d.id=t.to_zone_id
      WHERE t.vehicle_id=? AND t.status IN ('run','plan') ORDER BY t.starts_at LIMIT 1`).get(vehicle.id);
    // Следующее задание ищем среди ВСЕХ незавершённых рейсов, а не только
    // «в плане»: следующий рейс часто выводят на линию заранее, он получает
    // статус «в пути» — и тогда водителю отвечали «следующего задания нет»,
    // хотя оно назначено (кейс т018ав58: два рейса подряд, оба run).
    const next = active
      ? db.prepare(`SELECT t.*, f.name from_name, d.name to_name FROM trips t
        JOIN zones f ON f.id=t.from_zone_id JOIN zones d ON d.id=t.to_zone_id
        WHERE t.vehicle_id=? AND t.id<>? AND t.status IN ('run','plan')
          AND t.starts_at>=? ORDER BY t.starts_at LIMIT 1`)
        .get(vehicle.id, active.id, active.starts_at)
      : db.prepare(`SELECT t.*, f.name from_name, d.name to_name FROM trips t
        JOIN zones f ON f.id=t.from_zone_id JOIN zones d ON d.id=t.to_zone_id
        WHERE t.vehicle_id=? AND t.status IN ('run','plan') AND t.starts_at>?
        ORDER BY t.starts_at LIMIT 1`).get(vehicle.id, nowIso);
    const order = active?.order_id
      ? db.prepare(`SELECT o.*, fa.address from_address_text, ta.address to_address_text
          FROM orders o LEFT JOIN addresses fa ON fa.id=o.from_address_id
          LEFT JOIN addresses ta ON ta.id=o.to_address_id WHERE o.id=?`).get(active.order_id) : null;
    const stops = active ? listTripStops(db, active.id) : [];
    const transfer = db.prepare(`SELECT d.*, a.name to_name FROM vehicle_dispositions d
      LEFT JOIN addresses a ON a.id=d.address_id
      WHERE d.vehicle_id=? AND d.kind='transfer' AND d.arrived_at IS NULL
      ORDER BY d.starts_at DESC LIMIT 1`).get(vehicle.id);
    const dispositionNow = db.prepare(`SELECT * FROM vehicle_dispositions
      WHERE vehicle_id=? AND starts_at<=? AND ends_at>? ORDER BY starts_at DESC LIMIT 1`)
      .get(vehicle.id, nowIso, nowIso);
    const driver = db.prepare(`SELECT * FROM drivers WHERE vehicle_id=? AND status<>'fired' LIMIT 1`)
      .get(vehicle.id);
    const nextShift = db.prepare(`SELECT * FROM vehicle_dispositions
      WHERE vehicle_id=? AND kind='shift' AND ends_at>? ORDER BY starts_at LIMIT 1`)
      .get(vehicle.id, nowIso);
    const customerContacts = order?.customer_name
      ? db.prepare(`SELECT full_name, position, phone FROM customer_contacts
          WHERE customer_name=? AND phone<>'' ORDER BY full_name LIMIT 5`).all(order.customer_name) : [];
    // Ближайшие точки сервиса — от места, где машина сейчас.
    const place = vehiclePositionBefore(vehicle.id, nowIso);
    const services = db.prepare(`SELECT * FROM service_points WHERE active=1`).all()
      .map(item => ({ ...item,
        km: place && Number.isFinite(item.latitude)
          ? Math.round(roadKm(place.latitude, place.longitude, item.latitude, item.longitude)) : null }))
      .sort((a, b) => (a.km ?? 1e9) - (b.km ?? 1e9)).slice(0, 6);
    const openQuestions = db.prepare(`SELECT * FROM driver_questions
      WHERE vehicle_id=? AND closed_at IS NULL ORDER BY opened_at`).all(vehicle.id);
    // Комментарии смены по рейсу: заметка по рейсу и отметки контроля с
    // текстом. Те же записи видит диспетчер в карточке контроля — комментарий
    // ходит в обе стороны, кто бы его ни оставил.
    const notes = active ? db.prepare(`SELECT item_key,done_by,done_at,note FROM task_marks
      WHERE kind='dispatcher' AND note<>'' AND (item_key=? OR item_key LIKE ?)
        AND day>=? ORDER BY done_at DESC LIMIT 8`)
      .all(`prepnote|${active.id}`, `${active.id}|%`,
        new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10)) : [];
    return json(response, 200, {
      caller, vehicle, driver, active, next, order, stops, transfer, dispositionNow,
      nextShift, customerContacts, services, openQuestions, notes,
      placeText: vehiclePlaceText(vehicle.id), contacts: employeeContacts()
    });
  }

  // ── План парка: машины × дни месяца, круги и свободный ресурс ──
  if (request.method === 'GET' && pathname === '/api/fleet-plan') {
    const user = requirePermission(request, response, 'planner:read');
    if (!user) return;
    const month = String(url.searchParams.get('month') || new Date().toISOString().slice(0, 7));
    const monthStart = `${month}-01T00:00:00.000Z`;
    const days = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
    const monthEnd = new Date(Date.parse(monthStart) + days * 86_400_000).toISOString();
    return json(response, 200, {
      month, days,
      vehicles: db.prepare(`SELECT v.id, v.plate, v.driver_name, vt.name type_name
        FROM vehicles v LEFT JOIN vehicle_types vt ON vt.id=v.type_id
        WHERE v.status='work' ORDER BY v.plate`).all(),
      trips: db.prepare(`SELECT t.id, t.vehicle_id, t.starts_at, t.ends_at, t.unloaded_at, t.status,
          zf.name from_name, zt.name to_name, t.revenue_vat, t.customer_name
        FROM trips t JOIN zones zf ON zf.id=t.from_zone_id JOIN zones zt ON zt.id=t.to_zone_id
        WHERE t.status<>'rejected' AND t.starts_at<? AND t.ends_at>?`).all(monthEnd, monthStart),
      dispositions: db.prepare(`SELECT vehicle_id, kind, starts_at, ends_at
        FROM vehicle_dispositions WHERE starts_at<? AND ends_at>?`).all(monthEnd, monthStart),
      rounds: db.prepare(`SELECT p.vehicle_id, p.round_key, p.note FROM vehicle_round_plans p`).all()
    });
  }

  // Задание из «Регулятора баланса»: логист/руководитель отправляет рычаг
  // дня нужной роли (без водителя/ремонт/пересменка → Ресурсу, сетка →
  // Продажам) готовым текстом с конкретикой.
  if (request.method === 'POST' && pathname === '/api/fleet-plan/balance-task') {
    const actor = currentUser(request);
    const permission = ['trips:write', 'fleet:write', 'reports:read']
      .find(item => hasPermission(actor, item));
    const user = permission ? requirePermission(request, response, permission)
      : requirePermission(request, response, 'trips:write');
    if (!user) return;
    const body = await readJson(request);
    const lever = String(body.lever || '');
    const text = String(body.text || '').trim().slice(0, 900);
    if (!text) return errorJson(response, 422, 'Пустое задание');
    const role = lever === 'grid' ? 'sales' : 'resource';
    notify(role, `⚖ Регулятор баланса (от ${user.full_name || user.username}): ${text}`);
    audit(db, user, 'balance-task', 'fleet', null, { lever, text }, requestIp(request));
    return json(response, 200, { ok: true, role });
  }
  if (request.method === 'POST' && pathname === '/api/fleet-plan/round') {
    const user = requirePermission(request, response, 'trips:write');
    if (!user) return;
    const body = await readJson(request);
    const vehicle = db.prepare('SELECT id FROM vehicles WHERE id=?').get(String(body.vehicleId || ''));
    if (!vehicle) return errorJson(response, 404, 'ТС не найдено');
    if (!body.roundKey) {
      db.prepare('DELETE FROM vehicle_round_plans WHERE vehicle_id=?').run(vehicle.id);
    } else {
      db.prepare(`INSERT INTO vehicle_round_plans(vehicle_id,round_key,note,updated_by)
        VALUES(?,?,?,?)
        ON CONFLICT(vehicle_id) DO UPDATE SET round_key=excluded.round_key,
          note=excluded.note, updated_by=excluded.updated_by, updated_at=CURRENT_TIMESTAMP`)
        .run(vehicle.id, String(body.roundKey).slice(0, 20), String(body.note || '').slice(0, 200), user.id);
    }
    audit(db, user, 'fleet-round', 'vehicle', vehicle.id, { round: body.roundKey || null }, requestIp(request));
    return json(response, 200, { ok: true });
  }

  // ── Перецепка прицепов ──
  // Прицеп закреплён ровно за одним тягачом; перестановка — атомарная
  // операция с журналом: снять со старого, повесить на нового, при занятом
  // приёмнике — обмен (swap) или отцеп его прицепа в свободные. Раньше
  // прицеп переписывали руками в двух карточках ТС и он числился за обоими.
  if (request.method === 'GET' && pathname === '/api/trailers') {
    const user = requirePermission(request, response, 'planner:read');
    if (!user) return;
    const attached = db.prepare(`SELECT TRIM(trailer_plate) tp, id vehicle_id, plate
      FROM vehicles WHERE TRIM(COALESCE(trailer_plate,''))<>''
        AND LOWER(TRIM(trailer_plate)) NOT IN ('без прицепа','нет','-','—')`).all();
    // Свободные: последняя запись журнала по прицепу — «отцеплен», и сейчас
    // он не висит ни на одном ТС.
    const detached = db.prepare(`SELECT trailer_plate tp, MAX(moved_at) at FROM trailer_moves
      GROUP BY trailer_plate HAVING (SELECT to_vehicle_id FROM trailer_moves m2
        WHERE m2.trailer_plate=trailer_moves.trailer_plate ORDER BY moved_at DESC LIMIT 1) IS NULL`).all()
      .filter(row => !attached.some(item => item.tp === row.tp));
    return json(response, 200, { attached, detached });
  }

  if (request.method === 'POST' && pathname === '/api/trailer-move') {
    const user = requirePermission(request, response, 'fleet:write');
    if (!user) return;
    const body = await readJson(request);
    const trailerPlate = String(body.trailerPlate || '').trim();
    if (!trailerPlate) return errorJson(response, 422, 'Укажите прицеп');
    const holder = db.prepare(`SELECT id, plate, trailer_plate FROM vehicles
      WHERE TRIM(COALESCE(trailer_plate,''))=?`).get(trailerPlate);
    const target = body.toVehicleId
      ? db.prepare('SELECT id, plate, trailer_plate FROM vehicles WHERE id=?').get(String(body.toVehicleId))
      : null;
    if (body.toVehicleId && !target) return errorJson(response, 404, 'ТС-приёмник не найдено');
    if (target && holder && target.id === holder.id) {
      return errorJson(response, 422, 'Прицеп уже на этой сцепке');
    }
    const note = String(body.note || '').slice(0, 200);
    const move = db.prepare(`INSERT INTO trailer_moves(id,trailer_plate,from_vehicle_id,to_vehicle_id,note,moved_by)
      VALUES(?,?,?,?,?,?)`);
    const targetOld = target ? String(target.trailer_plate || '').trim() : '';
    db.exec('BEGIN IMMEDIATE');
    try {
      if (holder) db.prepare(`UPDATE vehicles SET trailer_plate='', updated_at=CURRENT_TIMESTAMP
        WHERE id=?`).run(holder.id);
      if (target) {
        if (targetOld && targetOld.toLowerCase() !== 'без прицепа') {
          if (body.swap && holder) {
            // Обмен: прицеп приёмника уезжает на прежний тягач.
            db.prepare(`UPDATE vehicles SET trailer_plate=?, updated_at=CURRENT_TIMESTAMP
              WHERE id=?`).run(targetOld, holder.id);
            move.run(randomUUID(), targetOld, target.id, holder.id, `обмен: ${note}`, user.id);
          } else {
            // Прицеп приёмника отцепляется в свободные.
            move.run(randomUUID(), targetOld, target.id, null, `отцеплен при перецепке: ${note}`, user.id);
          }
        }
        db.prepare(`UPDATE vehicles SET trailer_plate=?, updated_at=CURRENT_TIMESTAMP
          WHERE id=?`).run(trailerPlate, target.id);
      }
      move.run(randomUUID(), trailerPlate, holder?.id || null, target?.id || null, note, user.id);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    audit(db, user, 'trailer-move', 'vehicle', target?.id || holder?.id || null,
      { trailerPlate, from: holder?.plate || null, to: target?.plate || null, swap: Boolean(body.swap) },
      requestIp(request));
    return json(response, 200, { ok: true,
      moved: `${trailerPlate}: ${holder?.plate || 'свободен'} → ${target?.plate || 'отцеплен'}` });
  }

  // ── Отметка «данные направлены грузоотправителю» ──
  // Параллельная отметка подготовки выхода (не звено чек-листа): данные
  // водителя и ТС нужны клиенту для пропуска на погрузку. Без отметки рейс
  // не блокируется — просто карточка подсвечивает, что данные ещё не ушли.
  match = route(/^\/api\/trips\/([^/]+)\/shipper-notified$/, pathname);
  if (match && request.method === 'POST') {
    const user = requirePermission(request, response, 'trip-status:write');
    if (!user) return;
    const trip = db.prepare('SELECT id, shipper_notified_at FROM trips WHERE id=?').get(match[0]);
    if (!trip) return errorJson(response, 404, 'Рейс не найден');
    const body = await readJson(request);
    if (body.undo) {
      // Отметили не тот рейс — снять может любой диспетчер.
      db.prepare(`UPDATE trips SET shipper_notified_at=NULL, shipper_notified_by='',
        updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(match[0]);
      audit(db, user, 'shipper-notified-undo', 'trip', match[0], {}, requestIp(request));
      return json(response, 200, { ok: true });
    }
    if (trip.shipper_notified_at) return json(response, 200, { ok: true });
    db.prepare(`UPDATE trips SET shipper_notified_at=?, shipper_notified_by=?,
      updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(new Date().toISOString(), user.full_name || user.username || '', match[0]);
    audit(db, user, 'shipper-notified', 'trip', match[0], {}, requestIp(request));
    return json(response, 200, { ok: true });
  }

  // ── Вопросы водителей ──
  if (request.method === 'POST' && pathname === '/api/driver-questions') {
    const user = requireUser(request, response);
    if (!user) return;
    const body = await readJson(request);
    if (!QUESTION_TOPICS.some(topic => topic.key === body.topic)) {
      return errorJson(response, 422, 'Выберите тему вопроса');
    }
    const id = randomUUID();
    db.prepare(`INSERT INTO driver_questions(id,vehicle_id,trip_id,driver_name,phone,topic,note,
        opened_by,call_id) VALUES(?,?,?,?,?,?,?,?,?)`).run(
      id, body.vehicleId || null, body.tripId || null,
      String(body.driverName || '').slice(0, 120), phonePretty(body.phone || ''),
      body.topic, String(body.note || '').slice(0, 500), user.id, body.callId || null);
    const topic = QUESTION_TOPICS.find(item => item.key === body.topic);
    const plate = body.vehicleId
      ? db.prepare('SELECT plate FROM vehicles WHERE id=?').get(body.vehicleId)?.plate || '' : '';
    notify('dispatcher', `📞 Вопрос водителя${plate ? ` (${plate})` : ''}: ${topic.label}` +
      `${body.note ? ` — ${String(body.note).slice(0, 120)}` : ''}. Норматив ответа — 10 минут`,
    'question', id);
    audit(db, user, 'create', 'driver_question', id, { topic: body.topic, plate }, requestIp(request));
    return json(response, 201, { id });
  }
  match = route(/^\/api\/driver-questions\/([^/]+)\/close$/, pathname);
  if (match && request.method === 'POST') {
    const user = requireUser(request, response);
    if (!user) return;
    const body = await readJson(request);
    const resolution = String(body.resolution || '').trim();
    if (!resolution) return errorJson(response, 422, 'Опишите, как решён вопрос');
    const question = db.prepare('SELECT * FROM driver_questions WHERE id=?').get(match[0]);
    if (!question) return errorJson(response, 404, 'Вопрос не найден');
    if (question.closed_at) return json(response, 200, { ok: true });
    db.prepare(`UPDATE driver_questions SET closed_by=?,closed_at=CURRENT_TIMESTAMP,resolution=?
      WHERE id=?`).run(user.id, resolution.slice(0, 500), match[0]);
    audit(db, user, 'close', 'driver_question', match[0], { resolution }, requestIp(request));
    return json(response, 200, { ok: true });
  }
  if (request.method === 'GET' && pathname === '/api/driver-questions') {
    const user = requireUser(request, response);
    if (!user) return;
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    return json(response, 200, {
      items: listDriverQuestions(db, { openOnly: url.searchParams.get('open') === '1' }),
      topics: QUESTION_TOPICS,
      stats: from && to ? questionStats(db, from, to) : []
    });
  }

  // ── Порожний перегон ──
  // Машина освободилась не там, где нужна: гоним пустой под погрузку, домой,
  // в ремонт или на пересменку. Не рейс (груза и выручки нет), а диспозиция
  // с заданием водителю и контролем прибытия: факт прибытия становится
  // местоположением сцепки для следующего назначения.
  const TRANSFER_PURPOSES = ['под погрузку', 'на базу', 'в ремонт', 'на пересменку', 'к месту стоянки'];
  if (request.method === 'POST' && pathname === '/api/transfers') {
    // Перегон заводят и логист (планирует ресурс), и диспетчер (решение на линии).
    const actor = currentUser(request);
    const permission = hasPermission(actor, 'fleet:write') ? 'fleet:write'
      : hasPermission(actor, 'trips:write') ? 'trips:write' : 'trip-status:write';
    const user = requirePermission(request, response, permission);
    if (!user) return;
    const body = await readJson(request);
    if (!body.vehicleId || !body.addressId) {
      return errorJson(response, 422, 'Укажите ТС и точку назначения');
    }
    const target = db.prepare('SELECT id,name,region,latitude,longitude FROM addresses WHERE id=?')
      .get(body.addressId);
    if (!target) return errorJson(response, 404, 'Точка назначения не найдена');
    const startsAt = Number.isFinite(Date.parse(body.startsAt))
      ? new Date(Date.parse(body.startsAt)) : new Date();
    // Откуда и сколько порожняком: от места освобождения сцепки. Время в пути —
    // та же формула транзита, что и у рейса, только без грузовых операций.
    // Позиция сцепки: по последнему рейсу/перегону, а если истории нет —
    // по её геозоне, иначе перегон уходил бы с нулевым пробегом.
    const zoneName = db.prepare(`SELECT z.name FROM vehicles v LEFT JOIN zones z ON z.id=v.zone_id
      WHERE v.id=?`).get(body.vehicleId)?.name;
    const origin = vehiclePositionBefore(body.vehicleId, startsAt.toISOString())
      || addressPointByText(zoneName);
    const km = origin && Number.isFinite(target.latitude)
      ? roadKm(origin.latitude, origin.longitude, target.latitude, target.longitude) : null;
    const calc = settingsObject(db).calculation;
    const hours = Number.isFinite(km)
      ? (km / (Number(calc.techSpeedKmh) || 50)) * (Number(calc.transitFactor) || 1.5) : 12;
    const endsAt = Number.isFinite(Date.parse(body.endsAt))
      ? new Date(Date.parse(body.endsAt))
      : new Date(startsAt.getTime() + Math.max(1, hours) * 3_600_000);
    if (endsAt <= startsAt) return errorJson(response, 422, 'Прибытие должно быть позже выезда');
    const purpose = TRANSFER_PURPOSES.includes(String(body.purpose)) ? String(body.purpose) : 'под погрузку';
    // Подпись «откуда» — из той же позиции, от которой посчитан километраж,
    // и на момент ВЫЕЗДА, а не «сейчас». Иначе в задании стояло «Откуда:
    // Курск» при 222 км, посчитанных от Саратова: между ними был рейс,
    // который к моменту перегона уже завершится (кейс р459ху58).
    const fromLabel = String(vehiclePlaceText(body.vehicleId, startsAt.toISOString())
      || body.fromLabel || zoneName || '').slice(0, 120);
    const id = randomUUID();
    db.prepare(`INSERT INTO vehicle_dispositions(id,vehicle_id,kind,starts_at,ends_at,note,
        address_id,from_label,purpose,empty_km,created_by,updated_by)
      VALUES(?,?,'transfer',?,?,?,?,?,?,?,?,?)`).run(
      id, body.vehicleId, startsAt.toISOString(), endsAt.toISOString(),
      String(body.note || '').slice(0, 300), target.id, fromLabel, purpose,
      Number.isFinite(km) ? Math.round(km) : 0, user.id, user.id);
    const plate = db.prepare('SELECT plate FROM vehicles WHERE id=?').get(body.vehicleId)?.plate || '';
    notify('dispatcher', `🚚 Перегон порожним ${plate}: ${fromLabel || '—'} → ${target.name} ` +
      `(${purpose}). Передайте задание водителю и отметьте выезд`, 'vehicle', body.vehicleId);
    invalidateDraftsForVehicle(body.vehicleId);
    audit(db, user, 'create', 'transfer', id, { vehicleId: body.vehicleId, to: target.name, purpose },
      requestIp(request));
    return json(response, 201, { id, km: Number.isFinite(km) ? Math.round(km) : null,
      endsAt: endsAt.toISOString() });
  }
  match = route(/^\/api\/transfers\/([^/]+)\/step$/, pathname);
  if (match && request.method === 'POST') {
    const user = requirePermission(request, response, 'trip-status:write');
    if (!user) return;
    const body = await readJson(request);
    const column = ({ driver_notified: 'driver_notified_at', departed: 'departed_at',
      arrived: 'arrived_at' })[body.step];
    if (!column) return errorJson(response, 422, 'Неизвестный этап перегона');
    const transfer = db.prepare(`SELECT * FROM vehicle_dispositions WHERE id=? AND kind='transfer'`)
      .get(match[0]);
    if (!transfer) return errorJson(response, 404, 'Перегон не найден');
    const at = Number.isFinite(Date.parse(body.at)) ? new Date(Date.parse(body.at)).toISOString()
      : new Date().toISOString();
    if (transfer[column]) return json(response, 200, { ok: true });
    db.prepare(`UPDATE vehicle_dispositions SET ${column}=?,updated_by=?,
      updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(at, user.id, match[0]);
    // Прибытие закрывает перегон фактическим временем: с этого момента сцепка
    // стоит в точке назначения и доступна для следующего задания.
    if (body.step === 'arrived') {
      db.prepare(`UPDATE vehicle_dispositions SET ends_at=? WHERE id=? AND ends_at>?`)
        .run(at, match[0], at);
      // Машина стоит в новой точке — подгон следующих рейсов считается уже
      // отсюда, иначе километры перегона учитывались бы в рейсе повторно.
      refreshEmptyKm(transfer.vehicle_id);
    }
    audit(db, user, 'transfer_step', 'transfer', match[0], { step: body.step, at }, requestIp(request));
    return json(response, 200, { ok: true });
  }
  match = route(/^\/api\/transfers\/([^/]+)$/, pathname);
  if (match && request.method === 'DELETE') {
    const actor = currentUser(request);
    const user = requirePermission(request, response,
      hasPermission(actor, 'fleet:write') ? 'fleet:write' : 'trip-status:write');
    if (!user) return;
    const transfer = db.prepare(`SELECT * FROM vehicle_dispositions WHERE id=? AND kind='transfer'`)
      .get(match[0]);
    if (!transfer) return errorJson(response, 404, 'Перегон не найден');
    if (transfer.arrived_at) return errorJson(response, 409, 'Перегон завершён — отменить нельзя');
    db.prepare('DELETE FROM vehicle_dispositions WHERE id=?').run(match[0]);
    audit(db, user, 'delete', 'transfer', match[0], {}, requestIp(request));
    return json(response, 200, { ok: true });
  }

  if (request.method === 'POST' && pathname === '/api/dispositions') {
    // Диспозиции ведёт ресурсник (fleet:write); диспетчеру право нужно
    // для внештатной «поломки» — ремонт оформляется прямо из контроля.
    const dispositionActor = currentUser(request);
    const dispositionPermission = hasPermission(dispositionActor, 'fleet:write')
      ? 'fleet:write' : 'trip-status:write';
    const user = requirePermission(request, response, dispositionPermission);
    if (!user) return;
    const body = await readJson(request);
    const allowed = new Set(['reserve', 'repair', 'no_driver', 'shift', 'out']);
    if (!body.vehicleId || !allowed.has(body.kind)) {
      return errorJson(response, 422, 'ТС и вид диспозиции обязательны');
    }
    const startsAt = Date.parse(body.startsAt);
    const endsAt = Date.parse(body.endsAt);
    // Место ремонта: пробег до сервиса от позиции сцепки — «ремонтный пробег».
    const repairAddressId = body.kind === 'repair' ? (body.addressId || null) : null;
    const repairKm = repairAddressId
      ? (() => {
          const origin = vehiclePositionBefore(body.vehicleId, new Date(startsAt).toISOString());
          const target = addressPointById(repairAddressId);
          return origin && target
            ? roadKm(origin.latitude, origin.longitude, target.latitude, target.longitude) : null;
        })() : null;
    if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt) || endsAt <= startsAt) {
      return errorJson(response, 422, 'Некорректный период недоступности');
    }
    const id = randomUUID();
    db.prepare(`INSERT INTO vehicle_dispositions(
      id,vehicle_id,kind,starts_at,ends_at,note,address_id,repair_km,created_by,updated_by)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
      id, body.vehicleId, body.kind, new Date(startsAt).toISOString(),
      new Date(endsAt).toISOString(), String(body.note || ''),
      repairAddressId, repairKm, user.id, user.id);
    invalidateDraftsForVehicle(body.vehicleId);
    audit(db, user, 'create', 'disposition', id, body, requestIp(request));
    return json(response, 201, { id });
  }
  match = route(/^\/api\/dispositions\/([^/]+)$/, pathname);
  if (match && request.method === 'PATCH') {
    const user = requirePermission(request, response, 'fleet:write');
    if (!user) return;
    const body = await readJson(request);
    const current = db.prepare('SELECT * FROM vehicle_dispositions WHERE id=?').get(match[0]);
    if (!current) return errorJson(response, 404, 'Интервал не найден');
    // Перегон — не «интервал недоступности», и форма диспозиции его не
    // редактирует: у неё нет такого вида, поэтому сохранение молча
    // превращало перегон в ремонт и стирало точку назначения с этапами
    // (кейс с869рх58 Воронеж → Пенза 28.08: перегон исчез через минуту
    // после отметки «Прибыл», машина осталась числиться в Воронеже).
    if (current.kind === 'transfer') {
      return errorJson(response, 409, 'Это перегон порожним — правьте его в «Контроле на линии» ' +
        'или отмените кнопкой «✕» в списке перегонов. Форма диспозиции перегоны не меняет');
    }
    const startsAt = Date.parse(body.startsAt ?? current.starts_at);
    const endsAt = Date.parse(body.endsAt ?? current.ends_at);
    const kind = body.kind ?? current.kind;
    if (!['reserve', 'repair', 'no_driver', 'shift', 'out'].includes(kind) || endsAt <= startsAt) {
      return errorJson(response, 422, 'Некорректный интервал');
    }
    const patchVehicleId = body.vehicleId ?? current.vehicle_id;
    const patchAddressId = kind === 'repair'
      ? ('addressId' in body ? (body.addressId || null) : current.address_id) : null;
    const patchRepairKm = patchAddressId
      ? (() => {
          const origin = vehiclePositionBefore(patchVehicleId, new Date(startsAt).toISOString());
          const target = addressPointById(patchAddressId);
          return origin && target
            ? roadKm(origin.latitude, origin.longitude, target.latitude, target.longitude) : null;
        })() : null;
    db.prepare(`UPDATE vehicle_dispositions SET vehicle_id=?,kind=?,starts_at=?,ends_at=?,
      note=?,address_id=?,repair_km=?,updated_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(
      patchVehicleId, kind, new Date(startsAt).toISOString(),
      new Date(endsAt).toISOString(), String(body.note ?? current.note),
      patchAddressId, patchRepairKm, user.id, match[0]);
    invalidateDraftsForVehicle(patchVehicleId);
    if (patchVehicleId !== current.vehicle_id) invalidateDraftsForVehicle(current.vehicle_id);
    audit(db, user, 'update', 'disposition', match[0], body, requestIp(request));
    return json(response, 200, { ok: true });
  }
  if (match && request.method === 'DELETE') {
    const user = requirePermission(request, response, 'fleet:write');
    if (!user) return;
    db.prepare('DELETE FROM vehicle_dispositions WHERE id=?').run(match[0]);
    audit(db, user, 'delete', 'disposition', match[0], {}, requestIp(request));
    return json(response, 200, { ok: true });
  }

  // ── Внутренний чат: общие сообщения и авто-уведомления конвейера ──
  if (request.method === 'GET' && pathname === '/api/messages') {
    const user = requireUser(request, response);
    if (!user) return;
    return json(response, 200,
      chatMessages(db, user.id, rolesOf(user), Number(url.searchParams.get('after') || 0)));
  }
  // Групповые чаты: список моих групп, создание, правка состава/названия.
  if (request.method === 'GET' && pathname === '/api/chats') {
    const user = requireUser(request, response);
    if (!user) return;
    const payload = {
      items: chatGroups(db, user.id),
      hidden: db.prepare('SELECT room_key, hidden_after FROM chat_hidden WHERE user_id=?')
        .all(user.id)
    };
    // Корзина удалённых групп — администратору, для восстановления.
    if (rolesOf(user).includes('admin')) {
      payload.deleted = db.prepare(`SELECT c.id, c.title, c.deleted_at,
          (SELECT COUNT(*) FROM chat_members m WHERE m.chat_id=c.id) members_count,
          (SELECT COUNT(*) FROM messages ms WHERE ms.chat_id=c.id) messages_count
        FROM chats c WHERE c.deleted_at IS NOT NULL ORDER BY c.deleted_at DESC`).all();
    }
    return json(response, 200, payload);
  }
  // Скрыть переписку у себя (лички/общие ленты не удаляются — только
  // пропадают из списка; вернутся при новом сообщении или через «✚»).
  if (request.method === 'POST' && pathname === '/api/chat/hide') {
    const user = requireUser(request, response);
    if (!user) return;
    const body = await readJson(request);
    const roomKey = String(body.roomKey || '');
    if (!/^dm:.+/.test(roomKey)) return errorJson(response, 422, 'Скрыть можно только личную переписку');
    const lastId = db.prepare('SELECT MAX(id) id FROM messages').get().id || 0;
    db.prepare(`INSERT INTO chat_hidden(user_id,room_key,hidden_after)
      VALUES(?,?,?) ON CONFLICT(user_id,room_key) DO UPDATE SET
        hidden_after=excluded.hidden_after, hidden_at=CURRENT_TIMESTAMP`)
      .run(user.id, roomKey, lastId);
    return json(response, 200, { ok: true });
  }
  if (request.method === 'POST' && pathname === '/api/chats') {
    const user = requireUser(request, response);
    if (!user) return;
    const body = await readJson(request);
    const title = String(body.title || '').trim().slice(0, 60);
    if (!title) return errorJson(response, 422, 'Название группы обязательно');
    const memberIds = [...new Set([user.id, ...(Array.isArray(body.memberIds) ? body.memberIds : [])])]
      .map(String);
    const valid = db.prepare(`SELECT id FROM users
      WHERE active=1 AND deleted_at IS NULL AND id IN (${memberIds.map(() => '?').join(',')})`)
      .all(...memberIds).map(row => row.id);
    if (valid.length < 2) return errorJson(response, 422, 'В группе нужны хотя бы два участника');
    const id = randomUUID();
    db.prepare('INSERT INTO chats(id,title,created_by) VALUES(?,?,?)').run(id, title, user.id);
    const add = db.prepare('INSERT INTO chat_members(chat_id,user_id) VALUES(?,?)');
    for (const memberId of valid) add.run(id, memberId);
    // Первое сообщение — системное: группа создана, состав виден всем участникам.
    db.prepare(`INSERT INTO messages(author_id,author_name,kind,text,chat_id)
      VALUES(?,?,'user',?,?)`).run(user.id, user.full_name || user.username,
      `👥 Группа «${title}» создана (участников: ${valid.length})`, id);
    audit(db, user, 'create', 'chat', id, { title, members: valid.length });
    return json(response, 201, { id });
  }
  match = route(/^\/api\/chats\/([^/]+)$/, pathname);
  if (match && request.method === 'PATCH') {
    const user = requireUser(request, response);
    if (!user) return;
    const chat = db.prepare('SELECT * FROM chats WHERE id=?').get(match[0]);
    if (!chat) return errorJson(response, 404, 'Группа не найдена');
    if (chat.created_by !== user.id && !rolesOf(user).includes('admin')) {
      return errorJson(response, 403, 'Менять группу может её создатель или администратор');
    }
    const body = await readJson(request);
    if (body.title) {
      db.prepare('UPDATE chats SET title=? WHERE id=?')
        .run(String(body.title).trim().slice(0, 60), match[0]);
    }
    if (Array.isArray(body.memberIds)) {
      const memberIds = [...new Set([chat.created_by, ...body.memberIds])].map(String);
      const valid = db.prepare(`SELECT id FROM users
        WHERE active=1 AND deleted_at IS NULL AND id IN (${memberIds.map(() => '?').join(',')})`)
        .all(...memberIds).map(row => row.id);
      if (valid.length < 2) return errorJson(response, 422, 'В группе нужны хотя бы два участника');
      db.prepare('DELETE FROM chat_members WHERE chat_id=?').run(match[0]);
      const add = db.prepare('INSERT INTO chat_members(chat_id,user_id) VALUES(?,?)');
      for (const memberId of valid) add.run(match[0], memberId);
    }
    audit(db, user, 'update', 'chat', match[0], { title: body.title, members: body.memberIds?.length });
    return json(response, 200, { ok: true });
  }
  // Удаление группы — мягкое: скрывается у всех участников, история
  // сохраняется; восстановить может только администратор (корзина в чате).
  if (match && request.method === 'DELETE') {
    const user = requireUser(request, response);
    if (!user) return;
    const chat = db.prepare('SELECT * FROM chats WHERE id=? AND deleted_at IS NULL').get(match[0]);
    if (!chat) return errorJson(response, 404, 'Группа не найдена');
    if (chat.created_by !== user.id && !rolesOf(user).includes('admin')) {
      return errorJson(response, 403, 'Удалить группу может её создатель или администратор');
    }
    db.prepare('UPDATE chats SET deleted_at=CURRENT_TIMESTAMP WHERE id=?').run(match[0]);
    audit(db, user, 'delete', 'chat', match[0], { title: chat.title });
    return json(response, 200, { ok: true });
  }
  match = route(/^\/api\/chats\/([^/]+)\/restore$/, pathname);
  if (match && request.method === 'POST') {
    const user = requireUser(request, response);
    if (!user) return;
    if (!rolesOf(user).includes('admin')) {
      return errorJson(response, 403, 'Восстанавливает группы администратор');
    }
    const chat = db.prepare('SELECT * FROM chats WHERE id=? AND deleted_at IS NOT NULL').get(match[0]);
    if (!chat) return errorJson(response, 404, 'Удалённая группа не найдена');
    db.prepare('UPDATE chats SET deleted_at=NULL WHERE id=?').run(match[0]);
    audit(db, user, 'restore', 'chat', match[0], { title: chat.title });
    return json(response, 200, { ok: true });
  }
  // Собеседники для личных сообщений: все действующие сотрудники, кроме себя.
  if (request.method === 'GET' && pathname === '/api/chat/users') {
    const user = requireUser(request, response);
    if (!user) return;
    return json(response, 200, {
      items: db.prepare(`SELECT id,full_name,roles FROM users
        WHERE active=1 AND deleted_at IS NULL AND id<>? ORDER BY full_name`).all(user.id)
        .map(item => ({ ...item, roles: rolesOf(item) }))
    });
  }
  if (request.method === 'POST' && pathname === '/api/messages') {
    const user = requireUser(request, response);
    if (!user) return;
    const body = await readJson(request);
    const text = String(body.text || '').trim().slice(0, 500);
    if (!text) return errorJson(response, 422, 'Пустое сообщение');
    // Личное сообщение: адресат — действующий сотрудник, не сам себе.
    let recipientId = null;
    if (body.recipientId) {
      const recipient = db.prepare(`SELECT id FROM users
        WHERE id=? AND active=1 AND deleted_at IS NULL`).get(String(body.recipientId));
      if (!recipient) return errorJson(response, 422, 'Получатель не найден или отключён');
      if (recipient.id === user.id) return errorJson(response, 422, 'Нельзя писать самому себе');
      recipientId = recipient.id;
    }
    // Групповое сообщение: только участник группы.
    let chatId = null;
    if (!recipientId && body.chatId) {
      const membership = db.prepare(`SELECT 1 FROM chat_members m
          JOIN chats c ON c.id=m.chat_id AND c.deleted_at IS NULL
          WHERE m.chat_id=? AND m.user_id=?`)
        .get(String(body.chatId), user.id);
      if (!membership) return errorJson(response, 403, 'Вы не участник этой группы');
      chatId = String(body.chatId);
    }
    db.prepare(`INSERT INTO messages(author_id,author_name,kind,text,recipient_id,chat_id)
      VALUES(?,?,'user',?,?,?)`).run(user.id, user.full_name || user.username, text, recipientId, chatId);
    return json(response, 201, { ok: true });
  }

  // ── Уточнение суммы по заявке клиента (подготовка выхода) ──
  // Суммы заявок зачастую предварительные; перед внесением заказа в учётную
  // систему диспетчер сверяет ставку с клиентской заявкой: подтверждает
  // текущую или вносит точную. Новая сумма каскадом уходит в заявку и 1С,
  // продажи получают уведомление.
  match = route(/^\/api\/trips\/([^/]+)\/confirm-sum$/, pathname);
  if (match && request.method === 'POST') {
    const user = requirePermission(request, response, 'trip-status:write');
    if (!user) return;
    const trip = db.prepare(`SELECT t.*,v.plate FROM trips t
      JOIN vehicles v ON v.id=t.vehicle_id WHERE t.id=?`).get(match[0]);
    if (!trip) return errorJson(response, 404, 'Рейс не найден');
    if (['paid', 'rejected'].includes(trip.status)) {
      return errorJson(response, 422, 'Рейс закрыт — сумма меняется только через продажи');
    }
    const body = await readJson(request);
    const oldSum = Number(trip.revenue_vat || 0);
    let newSum = oldSum;
    if (body.rateVat !== undefined) {
      newSum = Number(body.rateVat);
      if (!Number.isFinite(newSum) || newSum <= 0) {
        return errorJson(response, 422, 'Сумма должна быть положительным числом');
      }
    }
    if (newSum !== oldSum) {
      db.prepare(`UPDATE trips SET revenue_vat=?,updated_by=?,updated_at=CURRENT_TIMESTAMP
        WHERE id=?`).run(newSum, user.id, match[0]);
      db.prepare(`UPDATE orders SET rate_vat=?,updated_at=CURRENT_TIMESTAMP
        WHERE deleted_at IS NULL AND (trip_id=? OR id=?)`)
        .run(newSum, match[0], trip.order_id || '');
      queueOutbox(db, 'trips', match[0], 'update', tripOutboxPayload(match[0]),
        integrationPublic().writePolicy === 'automatic');
      notify('sales', `💰 Сумма по заявке ${trip.order_no ? `№ ${trip.order_no} ` : ''}` +
        `(${trip.plate}) уточнена диспетчером: было ${Math.round(oldSum).toLocaleString('ru-RU')} ₽ → ` +
        `стало ${Math.round(newSum).toLocaleString('ru-RU')} ₽ (${user.full_name})`);
    }
    db.prepare(`UPDATE trips SET sum_confirmed_at=CURRENT_TIMESTAMP,sum_confirmed_by=? WHERE id=?`)
      .run(user.full_name || user.username, match[0]);
    audit(db, user, 'confirm-sum', 'trip', match[0], { oldSum, newSum });
    return json(response, 200, { ok: true, sum: newSum });
  }

  // ── Шаг диспетчеризации: подтверждение логиста и чек-лист диспетчера ──
  match = route(/^\/api\/trips\/([^/]+)\/step$/, pathname);
  if (match && request.method === 'POST') {
    const body = await readJson(request);
    // Спец-шаги долгов 1С: «внесу позже» и «данные в 1С обновлены».
    if (body.step === 'defer_1c' || body.step === '1c_updated') {
      const user = requirePermission(request, response, 'trip-status:write');
      if (!user) return;
      const trip = db.prepare('SELECT * FROM trips WHERE id=?').get(match[0]);
      if (!trip) return errorJson(response, 404, 'Рейс не найден');
      if (body.step === 'defer_1c') {
        if (trip.entered_1c_at) return errorJson(response, 409, 'Заказ уже внесён в 1С');
        db.prepare(`UPDATE trips SET deferred_1c_at=COALESCE(deferred_1c_at, ?),
          updated_by=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
          .run(new Date().toISOString(), user.id, match[0]);
      } else {
        db.prepare(`UPDATE trips SET needs_1c_update_at=NULL, needs_1c_note='',
          updated_by=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(user.id, match[0]);
      }
      audit(db, user, 'dispatch_step', 'trip', match[0], { step: body.step }, requestIp(request));
      return json(response, 200, { ok: true });
    }
    // Устаревший шаг «документы получены» (этап отменён 27.08.2026): вкладка,
    // открытая до обновления, шлёт его до перезагрузки страницы — отвечаем
    // успехом, иначе у диспетчера рейс «не проводится».
    const meta = DISPATCH_STEPS.find(item => item.step === body.step)
      || (body.step === 'docs_checked'
        ? { step: 'docs_checked', permission: 'trip-status:write', label: 'Документы получены' }
        : null);
    if (!meta) return errorJson(response, 422, 'Неизвестный шаг диспетчеризации');
    const user = requirePermission(request, response, meta.permission);
    if (!user) return;
    // Фактическое время события (если отмечают позже) — иначе «сейчас».
    const factAt = body.at && Number.isFinite(Date.parse(body.at))
      ? new Date(Date.parse(body.at)).toISOString() : null;
    try {
      const { trip, statusChanged } = applyDispatchStep(db, match[0], body.step, user.id, factAt);
      // Фактическое внесение в 1С гасит отложенный долг.
      if (body.step === 'entered_1c') {
        db.prepare(`UPDATE trips SET deferred_1c_at=NULL, debt_1c_alert_at=NULL WHERE id=?`).run(match[0]);
      }
      if (statusChanged) {
        queueOutbox(db, 'trips', match[0], 'update', tripOutboxPayload(match[0]),
          integrationPublic().writePolicy === 'automatic');
      }
      // Задание водителю уходит в Telegram (если водитель привязан) —
      // в момент отметки шага «Задание водителю».
      if (body.step === 'driver_notified') sendDriverAssignment(match[0]);
      // Передача задания следующему участнику конвейера.
      if (body.step === 'logist_confirm') {
        notify('dispatcher', `Логист подтвердил рейс ${routeText(trip)} — подготовьте выход (1С, задание водителю, линия)`, 'trip', match[0]);
      }
      audit(db, user, 'dispatch_step', 'trip', match[0], { step: body.step }, requestIp(request));
      return json(response, 200, { ok: true, statusChanged });
    } catch (error) {
      return errorJson(response, error.status || 500, error.message);
    }
  }

  // ── Опоздание на линии: уведомление продаж (клиента предупреждают они) ──
  match = route(/^\/api\/trips\/([^/]+)\/notify-delay$/, pathname);
  if (match && request.method === 'POST') {
    const user = requirePermission(request, response, 'trip-status:write');
    if (!user) return;
    const trip = db.prepare(`SELECT t.*,f.name from_name,z.name to_name FROM trips t
      JOIN zones f ON f.id=t.from_zone_id JOIN zones z ON z.id=t.to_zone_id
      WHERE t.id=?`).get(match[0]);
    if (!trip) return errorJson(response, 404, 'Рейс не найден');
    ensureTripStops(db, match[0]);
    const stops = stopsWithEstimates(listTripStops(db, match[0]), trip.status);
    const delayMs = tripDelayMs(stops);
    if (delayMs < 30 * 60_000) {
      return errorJson(response, 409, 'Рейс идёт в графике — уведомление не требуется');
    }
    const hours = Math.max(1, Math.round(delayMs / 3_600_000));
    notify('sales', `Рейс ${routeText(trip)} (${trip.vehicle_id ? db.prepare('SELECT plate FROM vehicles WHERE id=?').get(trip.vehicle_id)?.plate : ''}, ${trip.customer_name || 'без заказчика'}) опаздывает примерно на ${hours} ч — уведомите клиента о переносе прибытия`, 'trip', match[0]);
    db.prepare(`UPDATE trips SET delay_notified_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
      WHERE id=?`).run(match[0]);
    audit(db, user, 'notify_delay', 'trip', match[0], { delayMs }, requestIp(request));
    return json(response, 200, { ok: true, delayMs });
  }

  // ── Факт прибытия под выгрузку: с него отсчитываются выгрузка и простой ──
  match = route(/^\/api\/trips\/([^/]+)\/arrived$/, pathname);
  if (match && request.method === 'POST') {
    const user = requirePermission(request, response, 'trip-status:write');
    if (!user) return;
    const trip = db.prepare('SELECT * FROM trips WHERE id=?').get(match[0]);
    if (!trip) return errorJson(response, 404, 'Рейс не найден');
    if (trip.status !== 'run') return errorJson(response, 409, 'Рейс не на линии');
    const body = await readJson(request);
    const factAt = body?.at && Number.isFinite(Date.parse(body.at))
      ? new Date(Date.parse(body.at)).toISOString() : new Date().toISOString();
    // Отсчёт «не выгружают» начинается заново от факта прибытия.
    db.prepare(`UPDATE trips SET arrived_at=COALESCE(arrived_at,?),
      unload_alert_at=NULL,unload_ping_at=NULL,
      updated_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(factAt, user.id, match[0]);
    // Факт прибытия — и на конечной стоянке контроля (для отчёта пунктуальности).
    ensureTripStops(db, match[0]);
    const stops = listTripStops(db, match[0]);
    const last = stops[stops.length - 1];
    if (last && !last.actual_arrival) {
      db.prepare(`UPDATE trip_stops SET actual_arrival=?,updated_by=?,updated_at=CURRENT_TIMESTAMP
        WHERE id=?`).run(factAt, user.id, last.id);
    }
    audit(db, user, 'arrived', 'trip', match[0], { at: factAt }, requestIp(request));
    return json(response, 200, { ok: true });
  }

  // ── Простой на выгрузке: выставление клиенту ──
  match = route(/^\/api\/trips\/([^/]+)\/demurrage$/, pathname);
  if (match && request.method === 'POST') {
    const user = requirePermission(request, response, 'trip-status:write');
    if (!user) return;
    const body = await readJson(request);
    const trip = db.prepare('SELECT * FROM trips WHERE id=?').get(match[0]);
    if (!trip) return errorJson(response, 404, 'Рейс не найден');
    const hours = Math.max(0, Number(body.hours || 0));
    const rate = Math.max(0, Number(body.ratePerHour || 0));
    const amount = Math.round(hours * rate);
    if (!amount) return errorJson(response, 422, 'Укажите часы простоя и ставку');
    // Простой — часть выручки рейса: экономика и отчёты учитывают его сразу.
    db.prepare(`UPDATE trips SET demurrage_vat=demurrage_vat+?,revenue_vat=revenue_vat+?,
      updated_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(amount, amount, user.id, match[0]);
    notify('sales', `По рейсу ${routeText(trip)} (${trip.customer_name || 'без заказчика'}) выставлен простой на выгрузке: ${hours} ч × ${rate.toLocaleString('ru-RU')} ₽ = ${amount.toLocaleString('ru-RU')} ₽ — включите в счёт клиенту`, 'trip', match[0]);
    queueOutbox(db, 'trips', match[0], 'update', tripOutboxPayload(match[0]),
      integrationPublic().writePolicy === 'automatic');
    audit(db, user, 'demurrage', 'trip', match[0], { hours, rate, amount }, requestIp(request));
    return json(response, 200, { ok: true, amount });
  }

  // ── Контроль выполнения рейса: стоянки с планом/расчётом/фактом ──
  if (request.method === 'GET' && pathname === '/api/control') {
    const user = requirePermission(request, response, 'planner:read');
    if (!user) return;
    // По умолчанию — оперативное окно: вчера…послезавтра; отчёт передаёт свой период.
    const now = Date.now();
    const from = url.searchParams.get('from') || new Date(now - 86_400_000).toISOString();
    const to = url.searchParams.get('to') || new Date(now + 2 * 86_400_000).toISOString();
    if (!Number.isFinite(Date.parse(from)) || !Number.isFinite(Date.parse(to))) {
      return errorJson(response, 422, 'Некорректный период контроля');
    }
    return json(response, 200, { items: controlSnapshot(db, from, to) });
  }
  match = route(/^\/api\/trips\/([^/]+)\/stops$/, pathname);
  if (match && request.method === 'POST') {
    const user = requirePermission(request, response, 'trip-status:write');
    if (!user) return;
    const body = await readJson(request);
    const trip = db.prepare('SELECT * FROM trips WHERE id=?').get(match[0]);
    if (!trip) return errorJson(response, 404, 'Рейс не найден');
    if (!String(body.point || '').trim()) return errorJson(response, 422, 'Укажите пункт стоянки');
    ensureTripStops(db, match[0]);
    const stops = listTripStops(db, match[0]);
    const plannedArrival = body.plannedArrival && Number.isFinite(Date.parse(body.plannedArrival))
      ? new Date(Date.parse(body.plannedArrival)).toISOString() : null;
    const plannedDeparture = body.plannedDeparture && Number.isFinite(Date.parse(body.plannedDeparture))
      ? new Date(Date.parse(body.plannedDeparture)).toISOString() : null;
    const id = randomUUID();
    db.prepare(`INSERT INTO trip_stops(id,trip_id,seq,kind,point,planned_arrival,
      planned_departure,distance_km,note,updated_by) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
      id, match[0], 999, body.kind === 'P' ? 'P' : 'D', String(body.point).trim(),
      plannedArrival, plannedDeparture, Math.max(0, Number(body.distanceKm || 0)),
      String(body.note || '').trim(), user.id);
    // Промежуточные стоянки — между погрузкой и конечной выгрузкой,
    // по хронологии планового прибытия (без плана — в конец середины).
    const middle = [...stops.slice(1, -1), { id, planned_arrival: plannedArrival }]
      .sort((a, b) => String(a.planned_arrival || '9999').localeCompare(String(b.planned_arrival || '9999')));
    const reseq = db.prepare('UPDATE trip_stops SET seq=? WHERE id=?');
    [stops[0], ...middle, stops[stops.length - 1]].forEach((stop, index) => reseq.run(index + 1, stop.id));
    audit(db, user, 'create', 'trip_stop', id, body, requestIp(request));
    return json(response, 201, { id });
  }
  match = route(/^\/api\/stops\/([^/]+)$/, pathname);
  if (match && request.method === 'PATCH') {
    const user = requirePermission(request, response, 'trip-status:write');
    if (!user) return;
    const body = await readJson(request);
    const current = db.prepare('SELECT * FROM trip_stops WHERE id=?').get(match[0]);
    if (!current) return errorJson(response, 404, 'Стоянка не найдена');
    const timeField = value => {
      if (value === null || value === '') return null;
      const parsed = Date.parse(value);
      if (!Number.isFinite(parsed)) throw Object.assign(new Error('Некорректное время'), { status: 422 });
      return new Date(parsed).toISOString();
    };
    const fields = {};
    for (const [key, column] of [
      ['plannedArrival', 'planned_arrival'], ['plannedDeparture', 'planned_departure'],
      ['actualArrival', 'actual_arrival'], ['actualDeparture', 'actual_departure'],
      ['workStartedAt', 'work_started_at'], ['workFinishedAt', 'work_finished_at']
    ]) if (key in body) fields[column] = timeField(body[key]);
    if ('point' in body) fields.point = String(body.point || '').trim();
    if ('note' in body) fields.note = String(body.note || '').trim();
    if ('distanceKm' in body) fields.distance_km = Math.max(0, Number(body.distanceKm || 0));
    if (!Object.keys(fields).length) return errorJson(response, 422, 'Нет полей для обновления');
    // Хронология точек: прибыть на выгрузку раньше, чем уехал с погрузки,
    // физически нельзя — такие отметки закрывали рейс «выгружен», когда
    // машина ещё грузилась (кейс т726ву58: этап ткнули не на той точке).
    if (fields.actual_arrival) {
      const previous = db.prepare(`SELECT actual_departure, actual_arrival, point FROM trip_stops
        WHERE trip_id=? AND seq<? ORDER BY seq DESC LIMIT 1`).get(current.trip_id, current.seq);
      const prevMoment = previous && (previous.actual_departure || previous.actual_arrival);
      if (prevMoment && Date.parse(fields.actual_arrival) < Date.parse(prevMoment)) {
        return errorJson(response, 422, `Прибытие раньше события на предыдущей точке ` +
          `(«${(previous.point || '').slice(0, 40)}», ${prevMoment.slice(11, 16)} UTC) — проверьте, ту ли точку отмечаете`);
      }
    }
    db.prepare(`UPDATE trip_stops SET ${Object.keys(fields).map(column => `${column}=?`).join(',')},
      updated_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(...Object.values(fields), user.id, match[0]);
    // Факты двигают конвейер: «В пути» после отправления с погрузки,
    // «Выгружен» после прибытия и завершения работ на конечной.
    const newStatus = syncTripFromStops(db, current.trip_id, user.id);
    if (newStatus) {
      queueOutbox(db, 'trips', current.trip_id, 'update', tripOutboxPayload(current.trip_id),
        integrationPublic().writePolicy === 'automatic');
    }
    audit(db, user, 'update', 'trip_stop', match[0], body, requestIp(request));
    return json(response, 200, { ok: true, tripStatus: newStatus });
  }
  if (match && request.method === 'DELETE') {
    const user = requirePermission(request, response, 'trip-status:write');
    if (!user) return;
    const current = db.prepare('SELECT * FROM trip_stops WHERE id=?').get(match[0]);
    if (!current) return errorJson(response, 404, 'Стоянка не найдена');
    const count = db.prepare('SELECT COUNT(*) n FROM trip_stops WHERE trip_id=?').get(current.trip_id).n;
    if (count <= 2) return errorJson(response, 409, 'У рейса должны остаться погрузка и выгрузка');
    db.prepare('DELETE FROM trip_stops WHERE id=?').run(match[0]);
    listTripStops(db, current.trip_id).forEach((stop, index) =>
      db.prepare('UPDATE trip_stops SET seq=? WHERE id=?').run(index + 1, stop.id));
    audit(db, user, 'delete', 'trip_stop', match[0], {}, requestIp(request));
    return json(response, 200, { ok: true });
  }

  if (request.method === 'GET' && pathname === '/api/exceptions') {
    const user = requirePermission(request, response, 'planner:read');
    if (!user) return;
    // Оперативный реестр — только актуальное: проблемы завершившихся рейсов и
    // истёкших окон решить уже нельзя, они очищаются автоматически.
    // История конфликтов за любой период доступна в отчёте «История конфликтов».
    const nowIso = new Date().toISOString();
    const trips = listTrips().filter(trip => trip.ends_at >= nowIso);
    const dispositions = listDispositions();
    const conflicts = new Set();
    const grouped = Map.groupBy(
      trips.filter(item => item.status !== 'rejected'),
      item => item.vehicle_id
    );
    for (const vehicleTrips of grouped.values()) {
      for (let i = 0; i < vehicleTrips.length; i += 1) {
        for (let j = i + 1; j < vehicleTrips.length; j += 1) {
          const overlap = Math.min(Date.parse(vehicleTrips[i].ends_at), Date.parse(vehicleTrips[j].ends_at)) -
            Math.max(Date.parse(vehicleTrips[i].starts_at), Date.parse(vehicleTrips[j].starts_at));
          if (overlap > 6 * 3_600_000) {
            conflicts.add(vehicleTrips[i].id);
            conflicts.add(vehicleTrips[j].id);
          }
        }
      }
    }
    // «Резерв под заказ» — не недоступность: рейс поверх резерва — норма.
    const critical = trips.filter(trip => trip.status !== 'rejected' && dispositions.some(item =>
      item.kind !== 'reserve' && item.vehicle_id === trip.vehicle_id &&
      Date.parse(trip.starts_at) < Date.parse(item.ends_at) &&
      Date.parse(item.starts_at) < Date.parse(trip.ends_at)));
    // Отклонённые рейсы убраны из оперативного реестра: их реестр с причинами —
    // в отчёте руководителя «Отклонённые рейсы».
    const rejected = [];
    const conflictItems = trips.filter(trip => conflicts.has(trip.id));
    // Опоздания идущих рейсов из оперативного реестра убраны по решению
    // пользователя (2026-08-03) — вернёмся к этому позже; расчёт остаётся
    // в отчёте «Контроль выполнения рейсов».
    const delayed = [];
    // Заявки с истёкшим окном погрузки — тоже история: перевозку уже не выполнить.
    // Отклонённые заявки не считаются оперативной проблемой: они архивируются
    // в реестре отклонённых (доска продаж и отчёт «Реестр заявок») с причиной.
    const rejectedOrders = [];
    const returnedOrders = db.prepare(`SELECT o.*,f.name from_name,t.name to_name
      FROM orders o JOIN zones f ON f.id=o.from_zone_id JOIN zones t ON t.id=o.to_zone_id
      WHERE o.status='new' AND o.returned_at IS NOT NULL AND o.window_to>=?
      ORDER BY o.returned_at DESC`).all(nowIso);
    return json(response, 200, {
      count: critical.length + rejected.length + conflictItems.length +
        rejectedOrders.length + returnedOrders.length + delayed.length,
      critical, rejected, conflicts: conflictItems, rejectedOrders, returnedOrders, delayed,
      unavailableVehicles: db.prepare(`SELECT status,COUNT(*) count FROM vehicles
        WHERE status<>'work' GROUP BY status`).all()
    });
  }

  // Аналитика ресурса: машино-дни, КТГ и выручка по каждой сцепке.
  // ── Инвентаризация: сквозная проверка ресурса и процессов на «мусор» —
  // дубли, забытые машины, висящие рейсы, дыры в данных водителей, заявки
  // с ошибочными датами. Секции с объектами, фронт делает их кликабельными.
  // Автопочинка безопасной части находок инвентаризации: то, что не
  // требует человеческого решения — пробелы, мёртвые ссылки, пустые зоны.
  if (request.method === 'POST' && pathname === '/api/inventory/fix') {
    const user = requirePermission(request, response, 'fleet:write');
    if (!user) return;
    const fixed = {};
    // Хвостовые пробелы в закреплениях: «Чернов … » не матчился со
    // справочником и ботом водителей из-за пробела в конце.
    fixed.trimmedNames = db.prepare(`UPDATE vehicles SET driver_name=TRIM(driver_name)
      WHERE driver_name IS NOT NULL AND driver_name<>TRIM(driver_name)`).run().changes;
    // Уволенные не могут оставаться закреплёнными: ссылку на ТС снимаем,
    // ФИО в карточке работающего ТС чистим (только при точном совпадении и
    // если нет активного полного тёзки — его закрепление не трогаем).
    fixed.firedUnlinked = db.prepare(`UPDATE drivers SET vehicle_id=NULL
      WHERE status='fired' AND vehicle_id IS NOT NULL`).run().changes;
    fixed.firedNamesCleared = 0;
    for (const driver of db.prepare(`SELECT full_name FROM drivers WHERE status='fired'`).all()) {
      const twin = db.prepare(`SELECT 1 FROM drivers WHERE status<>'fired' AND TRIM(full_name)=TRIM(?)`)
        .get(driver.full_name);
      if (twin) continue;
      fixed.firedNamesCleared += db.prepare(`UPDATE vehicles SET driver_name=''
        WHERE status='work' AND TRIM(COALESCE(driver_name,''))=TRIM(?)`).run(driver.full_name).changes;
    }
    // Зоны адресов: субъект РФ из текста или ближайший центр по координатам.
    fixed.zonesFilled = 0;
    for (const address of db.prepare(`SELECT id, name, region, latitude, longitude FROM addresses
      WHERE zone_id IS NULL`).all()) {
      const hint = zoneHintForAddress(`${address.name || ''} ${address.region || ''}`,
        address.latitude, address.longitude);
      if (!hint) continue;
      db.prepare('UPDATE addresses SET zone_id=? WHERE id=?').run(hint.id, address.id);
      fixed.zonesFilled += 1;
    }
    // Негеокоженные адреса — на новый круг: сторож теперь пробует каскад
    // упрощений (без дома → первые два сегмента), часть добьётся.
    fixed.geocodeRetries = db.prepare(`UPDATE addresses SET geocode_try_at=NULL
      WHERE latitude IS NULL AND geocode_try_at IS NOT NULL`).run().changes;
    audit(db, user, 'inventory-fix', 'system', null, fixed, requestIp(request));
    return json(response, 200, { ok: true, fixed });
  }
  if (request.method === 'GET' && pathname === '/api/inventory') {
    const user = requirePermission(request, response, 'planner:read');
    if (!user) return;
    const scope = url.searchParams.get('scope') === 'all' && hasPermission(user, 'reports:read')
      ? 'all' : 'resource';
    const sections = [];
    const add = (key, title, hint, items) => sections.push({ key, title, hint, count: items.length, items: items.slice(0, 25) });
    const nowIso = new Date().toISOString();
    // Транспорт
    add('trailer_dupes', '🚛 Дубли прицепов', 'Один прицеп закреплён за несколькими работающими ТС — в карточках ошибка',
      db.prepare(`SELECT trailer_plate, GROUP_CONCAT(plate, ', ') plates FROM vehicles
        WHERE COALESCE(trailer_plate,'')<>'' AND status='work'
        GROUP BY trailer_plate HAVING COUNT(*)>1`).all()
        .map(row => ({ label: `прицеп ${row.trailer_plate}`, sub: row.plates })));
    add('no_driver', '👤 Работающие ТС без водителя в карточке', 'driver_name пуст — подбор и бот водителей эту машину не свяжут',
      db.prepare(`SELECT id, plate FROM vehicles WHERE status='work' AND TRIM(COALESCE(driver_name,''))=''`).all()
        .map(row => ({ label: row.plate, vehicleId: row.id })));
    add('no_zone_type', '📍 ТС без геозоны или типа кузова', 'Не попадают в подбор и потоки',
      db.prepare(`SELECT id, plate, zone_id, type_id FROM vehicles WHERE status='work'
        AND (zone_id IS NULL OR type_id IS NULL)`).all()
        .map(row => ({ label: row.plate, sub: [!row.zone_id && 'нет зоны', !row.type_id && 'нет типа'].filter(Boolean).join(', '), vehicleId: row.id })));
    add('forgotten', '💤 Забытые машины (3+ дня без рейса и диспозиции)', 'В работе, но никем не заняты и не объяснены — упущены из внимания',
      db.prepare(`SELECT v.id, v.plate, v.driver_name,
        (SELECT MAX(t.ends_at) FROM trips t WHERE t.vehicle_id=v.id AND t.status<>'rejected') last_end
        FROM vehicles v WHERE v.status='work'
        AND NOT EXISTS (SELECT 1 FROM trips t WHERE t.vehicle_id=v.id AND t.status IN ('plan','run') AND t.ends_at > ?)
        AND NOT EXISTS (SELECT 1 FROM vehicle_dispositions d WHERE d.vehicle_id=v.id
          AND d.starts_at < ? AND (d.ends_at IS NULL OR d.ends_at > ?))`)
        .all(nowIso, new Date(Date.now() + 86_400_000).toISOString(), nowIso)
        .filter(row => !row.last_end || Date.parse(row.last_end) < Date.now() - 72 * 3_600_000)
        .map(row => ({ label: row.plate, sub: row.last_end
          ? `последний рейс закончился ${row.last_end.slice(0, 10)}` : 'рейсов не было', vehicleId: row.id })));
    add('hanging_trips', '⏳ Висящие рейсы (план окончания прошёл, не закрыты)', 'Загрязняют контроль и статистику — закрыть фактом или разобраться',
      db.prepare(`SELECT t.id, t.ends_at, t.order_no, t.vehicle_id, v.plate, o.customer_name FROM trips t
        LEFT JOIN vehicles v ON v.id=t.vehicle_id LEFT JOIN orders o ON o.trip_id=t.id
        WHERE t.status='run' AND t.ends_at < datetime('now','-2 hours')
        AND EXISTS (SELECT 1 FROM trip_stops s WHERE s.trip_id=t.id AND s.actual_departure IS NULL)
        ORDER BY t.ends_at`).all()
        .map(row => ({ label: `${row.plate || '—'} №${row.order_no || '—'}`, vehicleId: row.vehicle_id,
          sub: `${(row.customer_name || '').slice(0, 24)} · план оконч. ${row.ends_at.slice(0, 10)}` })));
    add('future_online', '🚦 «В пути», а выход через 2+ суток', 'Выведены на линию слишком заранее — вероятно, забыты или дата ошибочна',
      db.prepare(`SELECT t.id, t.starts_at, t.order_no, t.vehicle_id, t.customer_name, v.plate FROM trips t
        LEFT JOIN vehicles v ON v.id=t.vehicle_id
        WHERE t.status='run' AND t.starts_at > datetime('now','+48 hours')`).all()
        .map(row => ({ label: `${row.plate || '—'} №${row.order_no || '—'}`, vehicleId: row.vehicle_id,
          tripId: row.id, action: 'back-to-plan',
          sub: `${(row.customer_name || '').slice(0, 22)} · выход ${mskStamp(row.starts_at)} МСК` })));
    add('after_repair', '🔧 Вышли из ремонта/пересменки — работы нет', 'Простой после недоступности: диспозиция закончилась, рейса не появилось',
      db.prepare(`SELECT DISTINCT v.id, v.plate, d.kind, d.ends_at FROM vehicle_dispositions d
        JOIN vehicles v ON v.id=d.vehicle_id
        WHERE v.status='work' AND d.ends_at IS NOT NULL
          AND d.ends_at < ? AND d.ends_at > datetime('now','-72 hours')
          AND NOT EXISTS (SELECT 1 FROM trips t WHERE t.vehicle_id=v.id AND t.status IN ('plan','run') AND t.ends_at > ?)
          AND NOT EXISTS (SELECT 1 FROM vehicle_dispositions d2 WHERE d2.vehicle_id=v.id AND d2.starts_at<=? AND (d2.ends_at IS NULL OR d2.ends_at>?))`)
        .all(nowIso, nowIso, nowIso, nowIso)
        .map(row => ({ label: row.plate, sub: `${row.kind} до ${row.ends_at.slice(0, 10)}`, vehicleId: row.id })));
    // Водители
    add('drv_no_phone', '📵 Водители без телефона', 'Не привяжутся к боту и приложению — задание Ларину',
      db.prepare(`SELECT full_name FROM drivers WHERE status<>'fired'
        AND TRIM(COALESCE(phone,''))='' ORDER BY full_name`).all()
        .map(row => ({ label: row.full_name })));
    add('drv_dupes', '👥 Два водителя на одном ТС', 'Задвоенное закрепление в справочнике водителей',
      db.prepare(`SELECT v.plate, GROUP_CONCAT(d.full_name, ' + ') names FROM drivers d
        JOIN vehicles v ON v.id=d.vehicle_id WHERE d.status<>'fired' AND d.vehicle_id IS NOT NULL
        GROUP BY d.vehicle_id HAVING COUNT(*)>1`).all()
        .map(row => ({ label: row.plate, sub: row.names })));
    add('drv_fired_linked', '🚪 Уволенные, оставшиеся в закреплениях', 'vehicle_id у уволенного или ФИО в карточке работающего ТС',
      db.prepare(`SELECT d.full_name, v.plate FROM drivers d
        LEFT JOIN vehicles v ON v.id=d.vehicle_id
        WHERE d.status='fired' AND (d.vehicle_id IS NOT NULL OR EXISTS (
          SELECT 1 FROM vehicles v2 WHERE v2.status='work' AND v2.driver_name IS NOT NULL
            AND d.full_name LIKE v2.driver_name || '%'))
          AND NOT EXISTS (SELECT 1 FROM drivers a WHERE a.status<>'fired'
            AND TRIM(a.full_name)=TRIM(d.full_name))`).all()
        .map(row => ({ label: row.full_name, sub: row.plate || 'ФИО в карточке ТС' })));
    add('drv_orphan_names', '❓ ФИО в карточке ТС без водителя в справочнике', 'Текст закрепления не матчится ни с одним активным водителем — бот не свяжет',
      db.prepare(`SELECT id, plate, driver_name FROM vehicles WHERE status='work'
        AND TRIM(COALESCE(driver_name,''))<>''
        AND NOT EXISTS (SELECT 1 FROM drivers d WHERE d.status<>'fired' AND d.full_name LIKE vehicles.driver_name || '%')`).all()
        .map(row => ({ label: row.plate, sub: row.driver_name, vehicleId: row.id })));
    if (scope === 'all') {
      // Заявки и процессы
      add('past_orders', '⏰ Заявки с погрузкой в прошлом без движения', 'Похоже на ошибку даты/месяца — исправить окно или отклонить',
        db.prepare(`SELECT o.order_no, o.customer_name, o.window_from, o.trip_id FROM orders o
          WHERE o.deleted_at IS NULL AND o.status NOT IN ('cancelled') AND o.stage < 4
            AND o.window_from < datetime('now','-24 hours')`).all()
          .filter(row => {
            if (!row.trip_id) return true;
            const trip = db.prepare('SELECT * FROM trips WHERE id=?').get(row.trip_id);
            return trip && ['plan', 'run'].includes(trip.status) && !tripHasMovementFacts(db, trip);
          })
          .map(row => ({ label: `№${row.order_no || '—'} ${(row.customer_name || '').slice(0, 24)}`,
            sub: `погрузка ${row.window_from.slice(0, 10)}` })));
      add('stuck_orders', '🐌 Застряли в конвейере (стадия не движется 3+ дня)', 'Живые заявки, стоящие на месте между ролями',
        db.prepare(`SELECT order_no, customer_name, stage, stage_changed_at FROM orders
          WHERE deleted_at IS NULL AND status NOT IN ('cancelled') AND stage < 3
            AND window_from > datetime('now','-24 hours')
            AND stage_changed_at < datetime('now','-72 hours')`).all()
          .map(row => ({ label: `№${row.order_no || '—'} ${(row.customer_name || '').slice(0, 24)}`,
            sub: `стадия ${row.stage} с ${String(row.stage_changed_at).slice(0, 10)}` })));
      add('no_vehicle_soon', '🚨 Подтверждены без ТС, погрузка в сутки', 'Горящие назначения',
        db.prepare(`SELECT order_no, customer_name, window_from FROM orders
          WHERE status='new' AND stage>=1 AND trip_id IS NULL AND deleted_at IS NULL
            AND window_from BETWEEN datetime('now') AND datetime('now','+24 hours')
          ORDER BY window_from`).all()
          .map(row => ({ label: `№${row.order_no || '—'} ${(row.customer_name || '').slice(0, 24)}`,
            sub: `погрузка ${String(row.window_from).slice(5, 16).replace('T', ' ')} UTC` })));
      const noCoords = db.prepare(`SELECT COUNT(*) n FROM addresses WHERE latitude IS NULL OR longitude IS NULL`).get().n;
      const noZone = db.prepare(`SELECT COUNT(*) n FROM addresses WHERE zone_id IS NULL`).get().n;
      add('addr_gaps', '🗺 Дыры справочника адресов', 'Без координат подбор меряет по центрам зон; без зоны — не фильтруется',
        [noCoords && { label: `${noCoords} адресов без координат`, sub: 'геокодер добирает по 1 в 90 с — проверьте ревизию зон' },
         noZone && { label: `${noZone} адресов без геозоны` }].filter(Boolean));
    }
    const total = sections.reduce((acc, section) => acc + section.count, 0);
    return json(response, 200, { scope, total, generatedAt: nowIso, sections });
  }
  if (request.method === 'GET' && pathname === '/api/resource-stats') {
    const user = requirePermission(request, response, 'planner:read');
    if (!user) return;
    try {
      return json(response, 200, vehicleUtilization(db,
        url.searchParams.get('from') || new Date(Date.now() - 30 * 86_400_000).toISOString(),
        url.searchParams.get('to') || new Date().toISOString()));
    } catch (error) {
      return errorJson(response, error.status || 500, error.message);
    }
  }

  if (request.method === 'GET' && pathname === '/api/reports') {
    const user = requirePermission(request, response, 'reports:read');
    if (!user) return;
    const start = url.searchParams.get('from') || settingsObject(db).general.horizonStart;
    const from = /^\d{4}-\d{2}$/.test(start) ? `${start}-01` : start;
    const base = new Date(`${from}T00:00:00.000Z`);
    const defaultTo = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 1)).toISOString();
    return json(response, 200, reportSnapshot(db, from, url.searchParams.get('to') || defaultTo));
  }
  // Явка водителей (контур ОУВ): список на день и отметка с классификацией
  // причин невыхода. Отмечает ресурс (право fleet:write), смотрят все.
  if (request.method === 'GET' && pathname === '/api/attendance') {
    const user = requirePermission(request, response, 'planner:read');
    if (!user) return;
    const day = String(url.searchParams.get('day') || new Date().toISOString().slice(0, 10));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return errorJson(response, 422, 'Нужен day (ГГГГ-ММ-ДД)');
    return json(response, 200, {
      day,
      reasons: ABSENCE_REASONS,
      summary: attendanceSummary(db, day),
      items: attendanceEffective(db, day)
    });
  }
  // Табель за период — коды по каждому водителю на основе эффективной явки.
  if (request.method === 'GET' && pathname === '/api/attendance/timesheet') {
    const user = requirePermission(request, response, 'planner:read');
    if (!user) return;
    const from = String(url.searchParams.get('from') || '');
    const to = String(url.searchParams.get('to') || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || to <= from) {
      return errorJson(response, 422, 'Нужны from и to (ГГГГ-ММ-ДД, to позже from)');
    }
    return json(response, 200, attendanceTimesheet(db, from, to));
  }

  // Периодные закрепления водителя за ТС: подмена на межвахту, командировка.
  if (request.method === 'POST' && pathname === '/api/driver-assignments') {
    const user = requirePermission(request, response, 'fleet:write');
    if (!user) return;
    const body = await readJson(request);
    const row = createDriverAssignment(db, {
      driverId: String(body.driverId || ''), vehicleId: String(body.vehicleId || ''),
      startsAt: String(body.startsAt || ''), endsAt: String(body.endsAt || ''),
      note: String(body.note || ''), userId: user.id
    });
    audit(db, user, 'assign-period', 'driver', row.driver_id,
      { vehicleId: row.vehicle_id, startsAt: row.starts_at, endsAt: row.ends_at }, requestIp(request));
    return json(response, 201, { item: row });
  }
  match = route(/^\/api\/driver-assignments\/([\w-]+)$/, pathname);
  if (match && request.method === 'DELETE') {
    const user = requirePermission(request, response, 'fleet:write');
    if (!user) return;
    const row = db.prepare('SELECT * FROM driver_assignments WHERE id=?').get(match[0]);
    if (!row) return errorJson(response, 404, 'Закрепление не найдено');
    db.prepare('DELETE FROM driver_assignments WHERE id=?').run(match[0]);
    audit(db, user, 'unassign-period', 'driver', row.driver_id,
      { vehicleId: row.vehicle_id, startsAt: row.starts_at, endsAt: row.ends_at }, requestIp(request));
    return json(response, 200, { ok: true });
  }

  // График работы водителей: закрепления/пересменки/отсутствия/явка
  // за период — для календаря в двух проекциях (водители и ТС).
  if (request.method === 'GET' && pathname === '/api/driver-schedule') {
    const user = requirePermission(request, response, 'planner:read');
    if (!user) return;
    const from = String(url.searchParams.get('from') || '');
    const to = String(url.searchParams.get('to') || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || to <= from) {
      return errorJson(response, 422, 'Нужны from и to (ГГГГ-ММ-ДД)');
    }
    return json(response, 200,
      driverScheduleData(db, `${from}T00:00:00.000Z`, `${to}T00:00:00.000Z`));
  }

  if (request.method === 'POST' && pathname === '/api/attendance') {
    const user = requirePermission(request, response, 'fleet:write');
    if (!user) return;
    const body = await readJson(request);
    const row = markAttendance(db, {
      driverId: String(body.driverId || ''), day: String(body.day || ''),
      status: String(body.status || ''), reason: String(body.reason || ''),
      note: String(body.note || ''), userId: user.id
    });
    audit(db, user, 'attendance', 'driver', row.driver_id,
      { day: row.day, status: row.status, reason: row.reason }, requestIp(request));
    return json(response, 200, { ok: true, item: row });
  }

  // Массовая отметка явки: 180 водителей по одному клику — это 144 отметки
  // в день, ресурсник вёл явку три дня и бросил. Одна кнопка закрывает всех
  // неотмеченных как «вышел»; исключения отмечаются после, поштучно.
  if (request.method === 'POST' && pathname === '/api/attendance/bulk') {
    const user = requirePermission(request, response, 'fleet:write');
    if (!user) return;
    const body = await readJson(request);
    const day = String(body.day || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return errorJson(response, 422, 'Нужен day (ГГГГ-ММ-ДД)');
    const driverIds = Array.isArray(body.driverIds) ? body.driverIds.slice(0, 400) : [];
    if (!driverIds.length) return errorJson(response, 422, 'Пустой список водителей');
    let marked = 0;
    for (const driverId of driverIds) {
      try {
        markAttendance(db, { driverId: String(driverId), day, status: 'present',
          reason: '', note: '', userId: user.id });
        marked += 1;
      } catch { /* уволенный или чужой id — пропускаем, остальных отмечаем */ }
    }
    audit(db, user, 'attendance-bulk', 'driver', null, { day, marked }, requestIp(request));
    return json(response, 200, { ok: true, marked });
  }

  if (request.method === 'GET' && pathname === '/api/reports/staff') {
    const user = requirePermission(request, response, 'reports:read');
    if (!user) return;
    const from = String(url.searchParams.get('from') || '').slice(0, 10);
    const to = String(url.searchParams.get('to') || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || to <= from) {
      return errorJson(response, 422, 'Нужны from и to (ГГГГ-ММ-ДД)');
    }
    return json(response, 200, staffReport(db, from, to));
  }
  if (request.method === 'GET' && pathname === '/api/periods/history') {
    const user = requirePermission(request, response, 'reports:read');
    if (!user) return;
    return json(response, 200, {
      items: db.prepare('SELECT * FROM period_snapshots ORDER BY period_start DESC').all()
        .map(item => ({ ...item, metrics: JSON.parse(item.metrics_json) }))
    });
  }
  match = route(/^\/api\/revenue-plans\/(\d{4}-\d{2}-\d{2})$/, pathname);
  if (match && request.method === 'PUT') {
    const user = requirePermission(request, response, 'reports:read');
    if (!user) return;
    const body = await readJson(request);
    const target = Math.max(0, Number(body.targetNet || 0));
    db.prepare(`INSERT INTO revenue_plans(period_start,target_net,updated_by,updated_at)
      VALUES(?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(period_start) DO UPDATE SET
      target_net=excluded.target_net,updated_by=excluded.updated_by,updated_at=CURRENT_TIMESTAMP`)
      .run(match[0], target, user.id);
    audit(db, user, 'update', 'revenue_plan', match[0], { targetNet: target }, requestIp(request));
    return json(response, 200, { ok: true });
  }
  match = route(/^\/api\/periods\/(\d{4}-\d{2}-\d{2})\/close$/, pathname);
  if (match && request.method === 'POST') {
    const user = requirePermission(request, response, 'reports:read');
    if (!user) return;
    const from = new Date(`${match[0]}T00:00:00.000Z`);
    const to = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));
    const metrics = reportSnapshot(db, from.toISOString(), to.toISOString());
    metrics.revenuePlan = Number(db.prepare('SELECT target_net FROM revenue_plans WHERE period_start=?')
      .get(match[0])?.target_net || 0);
    const id = randomUUID();
    db.prepare(`INSERT INTO period_snapshots(
      id,period_start,period_end,label,metrics_json,closed_by,closed_at)
      VALUES(?,?,?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(period_start) DO UPDATE SET
      period_end=excluded.period_end,label=excluded.label,metrics_json=excluded.metrics_json,
      closed_by=excluded.closed_by,closed_at=CURRENT_TIMESTAMP`).run(
      id, match[0], to.toISOString().slice(0, 10),
      new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(from),
      JSON.stringify(metrics), user.id);
    audit(db, user, 'close', 'period', match[0], metrics, requestIp(request));
    return json(response, 200, { snapshot: metrics });
  }

  if (request.method === 'GET' && pathname === '/api/preferences') {
    const user = requireUser(request, response);
    if (!user) return;
    const item = db.prepare('SELECT * FROM user_preferences WHERE user_id=?').get(user.id);
    return json(response, 200, {
      theme: item?.theme || 'light',
      preferences: item ? JSON.parse(item.preferences_json) : {}
    });
  }
  if (request.method === 'PUT' && pathname === '/api/preferences') {
    const user = requireUser(request, response);
    if (!user) return;
    const body = await readJson(request);
    const theme = ['light', 'dark', 'system'].includes(body.theme) ? body.theme : 'light';
    db.prepare(`INSERT INTO user_preferences(user_id,theme,preferences_json,updated_at)
      VALUES(?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(user_id) DO UPDATE SET
      theme=excluded.theme,preferences_json=excluded.preferences_json,updated_at=CURRENT_TIMESTAMP`)
      .run(user.id, theme, JSON.stringify(body.preferences || {}));
    return json(response, 200, { ok: true });
  }

  // Должность для отчётности (план/факт) — только admin; права не меняет.
  // Телефон сотрудника: по нему определяется входящий звонок и его же
  // диспетчер называет водителю («как связаться с механиком»).
  match = route(/^\/api\/admin\/users\/([\w-]+)\/phone$/, pathname);
  if (match && request.method === 'PATCH') {
    const user = requirePermission(request, response, 'users:write');
    if (!user) return;
    const body = await readJson(request);
    const digits = phoneDigits(body.phone);
    if (body.phone && digits.length !== 10) {
      return errorJson(response, 422, 'Телефон: 10 цифр номера, например +7 987 510-59-21');
    }
    const target = db.prepare('SELECT id FROM users WHERE id=?').get(match[0]);
    if (!target) return errorJson(response, 404, 'Пользователь не найден');
    db.prepare('UPDATE users SET phone=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
      .run(body.phone ? phonePretty(body.phone) : '', match[0]);
    audit(db, user, 'phone', 'user', match[0], {}, requestIp(request));
    return json(response, 200, { ok: true, phone: body.phone ? phonePretty(body.phone) : '' });
  }
  match = route(/^\/api\/admin\/users\/([\w-]+)\/job-role$/, pathname);
  if (match && request.method === 'PATCH') {
    const user = requirePermission(request, response, 'users:write');
    if (!user) return;
    const body = await readJson(request);
    const jobRole = String(body.jobRole || '');
    if (!['', 'sales', 'logist', 'dispatcher', 'resource'].includes(jobRole)) {
      return errorJson(response, 422, 'Должность: sales, logist, dispatcher, resource или пусто');
    }
    const target = db.prepare('SELECT id FROM users WHERE id=?').get(match[0]);
    if (!target) return errorJson(response, 404, 'Пользователь не найден');
    db.prepare(`UPDATE users SET job_role=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(jobRole, match[0]);
    audit(db, user, 'job-role', 'user', match[0], { jobRole }, requestIp(request));
    return json(response, 200, { ok: true });
  }
  if (request.method === 'GET' && pathname === '/api/admin/users') {
    const user = requirePermission(request, response, 'users:write');
    if (!user) return;
    return json(response, 200, {
      roles: ROLE_LABELS,
      items: db.prepare(`SELECT id,username,full_name,email,role,roles,active,guest,phone,job_role,
        created_at,updated_at FROM users WHERE deleted_at IS NULL ORDER BY active DESC,full_name`).all()
        .map(item => ({ ...item, roles: rolesOf(item) }))
    });
  }
  // Роли из тела запроса: массив roles (мульти-роли) либо legacy-строка role.
  // Возвращает null при некорректном наборе.
  const parseRoles = body => {
    const raw = body.roles !== undefined ? body.roles : (body.role !== undefined ? [body.role] : undefined);
    if (raw === undefined) return undefined;
    if (!Array.isArray(raw) || !raw.length) return null;
    const unique = [...new Set(raw)];
    return unique.every(role => ROLE_LABELS[role]) ? unique : null;
  };
  if (request.method === 'POST' && pathname === '/api/admin/users') {
    const user = requirePermission(request, response, 'users:write');
    if (!user) return;
    const body = await readJson(request);
    const roles = parseRoles(body);
    if (!body.username || !body.fullName || !roles) {
      return errorJson(response, 422, 'Логин, имя и хотя бы одна корректная роль обязательны');
    }
    if (typeof body.password !== 'string' || body.password.length < 10) {
      return errorJson(response, 422, 'Пароль должен содержать не менее 10 символов');
    }
    const id = randomUUID();
    db.prepare(`INSERT INTO users(id,username,full_name,email,password_hash,role,roles,active,guest)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(
      id, body.username.trim(), body.fullName.trim(), body.email || null,
      hashPassword(body.password || ''), roles[0], JSON.stringify(roles), body.active === false ? 0 : 1,
      body.guest ? 1 : 0);
    audit(db, user, 'create', 'user', id, { ...body, password: undefined }, requestIp(request));
    return json(response, 201, { id });
  }
  match = route(/^\/api\/admin\/users\/([^/]+)$/, pathname);
  if (match && request.method === 'PATCH') {
    const user = requirePermission(request, response, 'users:write');
    if (!user) return;
    const body = await readJson(request);
    const current = db.prepare('SELECT * FROM users WHERE id=?').get(match[0]);
    if (!current) return errorJson(response, 404, 'Пользователь не найден');
    if (match[0] === user.id && body.active === false) return errorJson(response, 422, 'Нельзя отключить собственную учетную запись');
    if (match[0] === user.id && body.guest === true) return errorJson(response, 422, 'Нельзя включить гостевой режим себе — потеряете доступ к настройкам');
    const nextRoles = parseRoles(body);
    if (nextRoles === null) return errorJson(response, 422, 'Нужна хотя бы одна корректная роль');
    if (body.password !== undefined && String(body.password).length < 10) {
      return errorJson(response, 422, 'Пароль должен содержать не менее 10 символов');
    }
    const currentRoles = rolesOf(current);
    const removesActiveAdmin = currentRoles.includes('admin') && current.active && !Number(current.guest) &&
      (body.active === false || body.guest === true ||
        (nextRoles !== undefined && !nextRoles.includes('admin')));
    if (removesActiveAdmin) {
      const otherAdmins = db.prepare(`SELECT COUNT(*) count FROM users, json_each(users.roles)
        WHERE json_each.value='admin' AND users.active=1 AND COALESCE(users.guest,0)=0
          AND users.deleted_at IS NULL AND users.id<>?`).get(match[0]).count;
      if (!otherAdmins) return errorJson(response, 422, 'В системе должен остаться хотя бы один активный администратор с правами редактирования');
    }
    const finalRoles = nextRoles ?? currentRoles;
    db.prepare(`UPDATE users SET username=?,full_name=?,email=?,role=?,roles=?,active=?,guest=?,
      password_hash=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(
      body.username ?? current.username, body.fullName ?? current.full_name,
      body.email ?? current.email, finalRoles[0], JSON.stringify(finalRoles),
      body.active === undefined ? current.active : Number(Boolean(body.active)),
      body.guest === undefined ? Number(current.guest || 0) : Number(Boolean(body.guest)),
      body.password ? hashPassword(body.password) : current.password_hash, match[0]);
    if (body.password || body.active === false) db.prepare('DELETE FROM sessions WHERE user_id=?').run(match[0]);
    audit(db, user, 'update', 'user', match[0], { ...body, password: undefined }, requestIp(request));
    return json(response, 200, { ok: true });
  }
  // Удаление пользователя. Учётка без единого следа в системе удаляется
  // физически (сессии и личные настройки — каскадом); учётка с историей
  // (журнал действий, сообщения, отметки) удаляется мягко: скрывается из
  // списка, доступ закрывается, логин освобождается для повторного
  // использования, а вся история и отчёты по сотруднику сохраняются.
  if (match && request.method === 'DELETE') {
    const user = requirePermission(request, response, 'users:write');
    if (!user) return;
    const current = db.prepare('SELECT * FROM users WHERE id=? AND deleted_at IS NULL').get(match[0]);
    if (!current) return errorJson(response, 404, 'Пользователь не найден');
    if (match[0] === user.id) return errorJson(response, 422, 'Нельзя удалить собственную учетную запись');
    if (rolesOf(current).includes('admin') && current.active) {
      const otherAdmins = db.prepare(`SELECT COUNT(*) count FROM users, json_each(users.roles)
        WHERE json_each.value='admin' AND users.active=1 AND users.deleted_at IS NULL
          AND users.id<>?`).get(match[0]).count;
      if (!otherAdmins) return errorJson(response, 422, 'В системе должен остаться хотя бы один активный администратор');
    }
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(match[0]);
    let mode = 'hard';
    try {
      db.prepare('DELETE FROM users WHERE id=?').run(match[0]);
    } catch {
      // Внешние ссылки (история) не пускают — мягкое удаление.
      mode = 'soft';
      db.prepare(`UPDATE users SET active=0, deleted_at=CURRENT_TIMESTAMP,
        username=username||'#del-'||substr(id,1,8), updated_at=CURRENT_TIMESTAMP
        WHERE id=?`).run(match[0]);
    }
    audit(db, user, 'delete', 'user', match[0],
      { mode, username: current.username, fullName: current.full_name }, requestIp(request));
    return json(response, 200, { ok: true, mode });
  }

  if (request.method === 'GET' && pathname === '/api/admin/settings') {
    const user = requirePermission(request, response, 'settings:write');
    if (!user) return;
    return json(response, 200, {
      settings: settingsObject(db), reference: allReferenceData(),
      vehicles: listVehicles(), dispositions: listDispositions(),
      customers: db.prepare(`SELECT c.*,f.name from_name,t.name to_name FROM customers c
        LEFT JOIN zones f ON f.id=c.from_zone_id LEFT JOIN zones t ON t.id=c.to_zone_id
        ORDER BY c.trip_count DESC`).all(),
      revenuePlans: db.prepare('SELECT * FROM revenue_plans ORDER BY period_start').all(),
      driverAssignments: db.prepare(`SELECT a.*,d.full_name driver_name,v.plate vehicle_plate
        FROM driver_assignments a
        JOIN drivers d ON d.id=a.driver_id JOIN vehicles v ON v.id=a.vehicle_id
        WHERE a.ends_at > datetime('now','-30 days') ORDER BY a.starts_at`).all(),
      periodSnapshots: db.prepare('SELECT * FROM period_snapshots ORDER BY period_start DESC').all(),
      network: { currentIp: requestIp(request) },
      integration: integrationPublic(),
      mappings: db.prepare('SELECT * FROM integration_mappings ORDER BY entity').all(),
      jobs: db.prepare('SELECT * FROM sync_jobs ORDER BY started_at DESC LIMIT 30').all(),
      outbox: db.prepare('SELECT * FROM outbox ORDER BY created_at DESC LIMIT 100').all()
    });
  }
  if (request.method === 'PUT' && pathname === '/api/admin/settings') {
    const user = requirePermission(request, response, 'settings:write');
    if (!user) return;
    const body = await readJson(request);
    if (body.networkAccess !== undefined) {
      let allowedSubnets;
      try {
        allowedSubnets = normalizeAllowedSubnets(body.networkAccess.allowedSubnets);
      } catch (error) {
        return errorJson(response, 422, error.message);
      }
      if (!ipInSubnets(requestIp(request), allowedSubnets)) {
        return errorJson(response, 422,
          'Текущий IP должен входить хотя бы в одну подсеть, иначе вы потеряете доступ');
      }
      body.networkAccess = { allowedSubnets };
    }
    const update = db.prepare(`INSERT INTO settings(key,value_json,updated_by,updated_at)
      VALUES(?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET
      value_json=excluded.value_json,updated_by=excluded.updated_by,updated_at=CURRENT_TIMESTAMP`);
    for (const key of ['general', 'calculation', 'statuses', 'rejectionReasons',
      'orderOptions', 'networkAccess', 'telephony', 'telegram', 'notifyRules']) {
      if (body[key] !== undefined) update.run(key, JSON.stringify(body[key]), user.id);
    }
    audit(db, user, 'update', 'settings', null, Object.keys(body), requestIp(request));
    return json(response, 200, { ok: true });
  }
  if (request.method === 'PUT' && pathname === '/api/admin/reference') {
    const user = requirePermission(request, response, 'settings:write');
    if (!user) return;
    const body = await readJson(request);
    db.exec('BEGIN IMMEDIATE');
    try {
      const updateZone = db.prepare(`UPDATE zones SET name=?,color=?,sort_order=?,
        latitude=?,longitude=? WHERE id=?`);
      for (const [index, zone] of (body.zones || []).entries()) {
        updateZone.run(
          String(zone.name).trim(), String(zone.color).trim(), index,
          zone.latitude === '' ? null : Number(zone.latitude),
          zone.longitude === '' ? null : Number(zone.longitude), zone.id);
        if (Array.isArray(zone.aliases)) {
          db.prepare('DELETE FROM zone_aliases WHERE zone_id=?').run(zone.id);
          const putAlias = db.prepare('INSERT INTO zone_aliases(id,zone_id,alias) VALUES(?,?,?)');
          for (const alias of zone.aliases.map(item => String(item).trim()).filter(Boolean)) {
            putAlias.run(randomUUID(), zone.id, alias);
          }
        }
      }
      const updateType = db.prepare('UPDATE vehicle_types SET name=? WHERE id=?');
      for (const type of body.vehicleTypes || []) updateType.run(String(type.name).trim(), type.id);
      const updateRate = db.prepare('UPDATE route_rates SET distance_km=?,default_rate_vat=? WHERE id=?');
      for (const rate of body.routeRates || []) {
        updateRate.run(Number(rate.distanceKm), Number(rate.defaultRateVat), rate.id);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    audit(db, user, 'update', 'reference', null, {
      zones: body.zones?.length || 0, vehicleTypes: body.vehicleTypes?.length || 0,
      routeRates: body.routeRates?.length || 0
    }, requestIp(request));
    return json(response, 200, { ok: true });
  }
  if (request.method === 'PUT' && pathname === '/api/admin/integration') {
    const user = requirePermission(request, response, 'integration:write');
    if (!user) return;
    const body = await readJson(request);
    const current = db.prepare('SELECT * FROM integration_config WHERE id=1').get();
    db.prepare(`UPDATE integration_config SET base_url=?,username=?,password_cipher=?,enabled=?,
      pull_interval_min=?,write_enabled=?,write_policy=?,verify_tls=?,updated_at=CURRENT_TIMESTAMP WHERE id=1`).run(
      body.baseUrl || '', body.username || '',
      body.password ? encryptSecret(body.password, config.appSecret) : current.password_cipher,
      Number(Boolean(body.enabled)), Math.max(5, Number(body.pullIntervalMin || 30)),
      Number(Boolean(body.writeEnabled)), body.writePolicy === 'automatic' ? 'automatic' : 'manual',
      body.verifyTls === false ? 0 : 1);
    if (Array.isArray(body.mappings)) {
      const update = db.prepare(`UPDATE integration_mappings SET entity_set=?,direction=?,
        field_map_json=?,filter_query=?,enabled=?,updated_at=CURRENT_TIMESTAMP WHERE entity=?`);
      for (const mapping of body.mappings) update.run(
        mapping.entitySet, mapping.direction, JSON.stringify(mapping.fieldMap),
        mapping.filterQuery || '', Number(Boolean(mapping.enabled)), mapping.entity);
    }
    if (body.telematics) {
      const connector = db.prepare(`SELECT * FROM integration_connectors
        WHERE id='telematics'`).get();
      db.prepare(`UPDATE integration_connectors SET base_url=?,token_cipher=?,enabled=?,
        updated_at=CURRENT_TIMESTAMP WHERE id='telematics'`).run(
        String(body.telematics.baseUrl || ''),
        body.telematics.token
          ? encryptSecret(String(body.telematics.token), config.appSecret)
          : connector.token_cipher,
        Number(Boolean(body.telematics.enabled)));
    }
    audit(db, user, 'update', 'integration', '1', { ...body, password: undefined }, requestIp(request));
    return json(response, 200, { ok: true });
  }
  if (request.method === 'POST' && pathname === '/api/admin/integration/test') {
    const user = requirePermission(request, response, 'integration:write');
    if (!user) return;
    const row = db.prepare('SELECT * FROM integration_config WHERE id=1').get();
    return json(response, 200, await testConnection(row, config.appSecret));
  }
  if (request.method === 'POST' && pathname === '/api/admin/integration/sync') {
    const user = requirePermission(request, response, 'integration:write');
    if (!user) return;
    const jobId = await runPull(db, config.appSecret, null, true);
    return json(response, 202, { jobId });
  }
  if (request.method === 'POST' && pathname === '/api/admin/integration/import/1c') {
    const user = requirePermission(request, response, 'integration:write');
    if (!user) return;
    const body = await readJson(request, 10_000_000);
    const result = importTripsFrom1C(db, Array.isArray(body) ? body : body.items, user);
    audit(db, user, 'import', '1c_trips', null, result, requestIp(request));
    return json(response, 200, result);
  }
  if (request.method === 'POST' && pathname === '/api/admin/integration/import/telematics') {
    const user = requirePermission(request, response, 'integration:write');
    if (!user) return;
    const body = await readJson(request, 10_000_000);
    const result = importTelematics(db, Array.isArray(body) ? body : body.items, user);
    if (result.matched) db.prepare(`UPDATE integration_connectors
      SET last_success_at=CURRENT_TIMESTAMP WHERE id='telematics'`).run();
    audit(db, user, 'import', 'telematics', null, result, requestIp(request));
    return json(response, 200, result);
  }
  if (request.method === 'GET' && pathname === '/api/admin/integration/export') {
    const user = requirePermission(request, response, 'integration:write');
    if (!user) return;
    const kind = url.searchParams.get('kind') || 'plan';
    if (kind === 'clients') {
      return json(response, 200, {
        version: '1.0', items: db.prepare(`SELECT c.name client,f.name zoneFrom,t.name zoneTo,
          c.trip_count trips,c.average_rate_vat avgRevenue,c.trips_per_month tripsPerMonth
          FROM customers c LEFT JOIN zones f ON f.id=c.from_zone_id
          LEFT JOIN zones t ON t.id=c.to_zone_id ORDER BY c.name`).all()
      });
    }
    if (kind === 'archive') {
      return json(response, 200, {
        version: '1.0', items: db.prepare('SELECT * FROM period_snapshots ORDER BY period_start').all()
          .map(item => ({ ...item, metrics: JSON.parse(item.metrics_json), metrics_json: undefined }))
      });
    }
    if (kind === 'period') {
      const from = url.searchParams.get('from') || settingsObject(db).general.horizonStart;
      const date = new Date(`${from}T00:00:00.000Z`);
      const to = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
      return json(response, 200, { version: '1.0', data: reportSnapshot(db, from, to.toISOString()) });
    }
    return json(response, 200, { version: '1.0', items: listTrips(url.searchParams.get('date') || '') });
  }
  match = route(/^\/api\/admin\/outbox\/([^/]+)\/(approve|retry|cancel)$/, pathname);
  if (match && request.method === 'POST') {
    const user = requirePermission(request, response, 'integration:write');
    if (!user) return;
    const status = match[1] === 'cancel' ? 'cancelled' : 'approved';
    db.prepare(`UPDATE outbox SET status=?,approved_by=?,approved_at=CURRENT_TIMESTAMP,
      next_attempt_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(status, user.id, match[0]);
    if (status === 'approved') await processOutbox(db, config.appSecret, 1);
    audit(db, user, match[1], 'outbox', match[0], {}, requestIp(request));
    return json(response, 200, { ok: true });
  }

  return errorJson(response, 404, 'API endpoint не найден');
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json'
};

// Версия ассетов меняется при каждом старте сервера: HTML ссылается на
// /assets/v<версия>/…, поэтому после деплоя браузеры (включая Safari с его
// агрессивным кешем ES-модулей) получают новые URL и не смешивают версии.
// Относительные import'ы внутри модулей наследуют версионированный путь.
const ASSET_VERSION = Date.now().toString(36);
const VERSIONED_ASSETS = /^\/assets\/v[a-z0-9]+\//;

function staticFile(request, response, url) {
  let pathname = url.pathname === '/' ? '/login.html' : url.pathname;
  if (pathname === '/planner') pathname = '/app.html';
  if (pathname === '/settings') pathname = '/settings.html';
  const versioned = VERSIONED_ASSETS.test(pathname);
  if (versioned) pathname = pathname.replace(VERSIONED_ASSETS, '/assets/');
  const resolved = path.resolve(config.publicPath, `.${pathname}`);
  if (!resolved.startsWith(`${config.publicPath}${path.sep}`)) return errorJson(response, 403, 'Запрещено');
  if (!fs.existsSync(resolved)) return errorJson(response, 404, 'Страница не найдена');
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) return errorJson(response, 404, 'Страница не найдена');
  const html = path.extname(resolved) === '.html';
  // Версионированные URL уникальны для каждого деплоя — их можно кешировать намертво.
  // HTML и неверсионированные пути ревалидируются каждый раз (no-cache + ETag → 304).
  // В development версия не применяется: правки public/ должны подхватываться без рестарта.
  const cacheControl = versioned && config.isProduction ? 'public, max-age=31536000, immutable' : 'no-cache';
  const etag = `"${ASSET_VERSION}-${Math.round(stat.mtimeMs).toString(36)}-${stat.size.toString(36)}"`;
  if (request.headers['if-none-match'] === etag) {
    response.writeHead(304, { ETag: etag, 'Cache-Control': cacheControl });
    return response.end();
  }
  let content = fs.readFileSync(resolved);
  if (html && config.isProduction) {
    content = Buffer.from(content.toString('utf8').replaceAll('/assets/', `/assets/v${ASSET_VERSION}/`));
  }
  response.writeHead(200, {
    'Content-Type': MIME[path.extname(resolved)] || 'application/octet-stream',
    'Content-Length': content.length,
    'Cache-Control': cacheControl,
    ETag: etag
  });
  response.end(content);
}

export const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'same-origin');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Content-Security-Policy',
    "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  try {
    if (!networkAccessAllowed(request, url.pathname)) {
      return errorJson(response, 403, 'Подключение из вашей сети запрещено администратором');
    }
    if (url.pathname.startsWith('/api/')) await api(request, response, url);
    else staticFile(request, response, url);
  } catch (error) {
    const status = error.status || (String(error.message).includes('UNIQUE constraint') ? 409 : 500);
    if (status >= 500) console.error(error);
    if (!response.headersSent) errorJson(response, status, status === 500 ? 'Внутренняя ошибка сервера' : error.message);
    else response.end();
  }
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(config.port, config.host, () => {
    console.log(`PegasLogistic: http://${config.host}:${config.port}`);
    if (!config.isProduction && config.admin.password === 'ChangeMe-2026!') {
      console.warn('Первый вход: admin / ChangeMe-2026! — смените пароль в настройках.');
    }
  });

  let shuttingDown = false;
  const shutdown = signal => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Получен ${signal}, штатная остановка PegasLogistic`);
    closeServer().then(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

export function closeServer() {
  return new Promise(resolve => server.close(() => {
    db.close();
    resolve();
  }));
}
