import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config } from './config.mjs';
import { audit, nextOrderNo, nextRouteNo, openDatabase, queueOutbox, roadKm, settingsObject } from './db.mjs';
import { ipInSubnets, normalizeAllowedSubnets } from './network-access.mjs';
import { ROLE_LABELS, hasPermission, permissionsForRoles, roleLabelsFor, rolesOf } from './permissions.mjs';
import {
  encryptSecret, hashPassword, newSessionToken, parseCookies, tokenHash, verifyPassword
} from './security.mjs';
import { processOutbox, runPull, startIntegrationScheduler, testConnection } from './odata.mjs';
import {
  importTelematics, importTripsFrom1C, reportSnapshot, resolveZone, transitHours, vehicleUtilization
} from './planner-service.mjs';
import {
  DISPATCH_STEPS, applyDispatchStep, checkStuckUnloading, controlSnapshot, ensureTripStops,
  listTripStops, resetDriverNotificationOnVehicleChange, stampStopsFromStatus,
  stopsWithEstimates, syncTripFromStops, tripDelayMs
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
  const { networkAccess: _networkAccess, ...settings } = settingsObject(db);
  return settings;
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

function publicUser(user) {
  const roles = rolesOf(user);
  return {
    id: user.id, username: user.username, fullName: user.full_name, email: user.email || '',
    role: user.role, roles, roleLabel: roleLabelsFor(roles), active: Boolean(user.active),
    permissions: permissionsForRoles(roles)
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
  return db.prepare(`SELECT d.*,v.plate vehicle_plate FROM vehicle_dispositions d
    JOIN vehicles v ON v.id=d.vehicle_id ORDER BY d.starts_at,v.plate`).all();
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
function notify(targetRole, text, entity = null, entityId = null) {
  db.prepare(`INSERT INTO messages(author_name,kind,text,target_role,entity,entity_id)
    VALUES('Конвейер','auto',?,?,?,?)`).run(text, targetRole, entity, entityId);
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
        notify('sales', `${label} не выгружают более 6 ч — уведомите клиента; простой можно выставить в «Диспетчере»`, 'trip', event.trip.id);
        notify('logist', `${label} стоит на выгрузке ${hours} ч — учтите при планировании следующих рейсов сцепки`, 'trip', event.trip.id);
      } else {
        notify('dispatcher', `Особый контроль: ${label} стоит на выгрузке уже ${hours} ч — проверьте статус и зафиксируйте простой`, 'trip', event.trip.id);
      }
    }
  } catch (error) {
    console.error('Сторож выгрузки:', error.message);
  }
}
setInterval(runUnloadWatch, 10 * 60_000);
setTimeout(runUnloadWatch, 15_000);

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
        notify('resource', text, 'vehicle', vehicle.id);
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
      const osm = await fetch('https://nominatim.openstreetmap.org/search?' + new URLSearchParams({
        format: 'jsonv2', addressdetails: '1', countrycodes: 'ru', limit: '5', q: query
      }), {
        headers: { 'User-Agent': 'PegasLogistic/1.0 (dispatch planner; tkpegasnigovorin@gmail.com)' },
        signal: AbortSignal.timeout(7000)
      });
      if (!osm.ok) return errorJson(response, 502, `Источник геокодинга недоступен (${osm.status})`);
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
      return json(response, 200, {
        items: rows.map(row => ({
          name: row.display_name,
          latitude: Number(row.lat),
          longitude: Number(row.lon),
          region: normalizeRegion(row.address?.state || row.address?.city || '')
        }))
      });
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
      routes: db.prepare(`SELECT r.*,v.plate vehicle_plate FROM routes r
        LEFT JOIN vehicles v ON v.id=r.vehicle_id
        WHERE r.status IN ('draft','handed','assigned')
        ORDER BY r.created_at DESC`).all()
    });
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
      items: db.prepare(`SELECT item_key,done_by,done_at FROM task_marks
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
    const user = requirePermission(request, response, permissionByKind[kind]);
    if (!user) return;
    const existing = db.prepare(`SELECT 1 FROM task_marks WHERE kind=? AND day=? AND item_key=?`)
      .get(kind, day, key);
    if (existing) {
      db.prepare(`DELETE FROM task_marks WHERE kind=? AND day=? AND item_key=?`).run(kind, day, key);
    } else {
      db.prepare(`INSERT INTO task_marks(kind,day,item_key,done_by) VALUES(?,?,?,?)`)
        .run(kind, day, key, user.full_name || user.username || '');
    }
    return json(response, 200, { done: !existing });
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
    const merged = normalizeTrip({
      vehicleId: body.vehicleId ?? current.vehicle_id, orderId: body.orderId ?? current.order_id,
      customerName: body.customerName ?? current.customer_name,
      fromZoneId: body.fromZoneId ?? current.from_zone_id, toZoneId: body.toZoneId ?? current.to_zone_id,
      fromPoint: body.fromPoint ?? current.from_point, toPoint: body.toPoint ?? current.to_point,
      startsAt: body.startsAt ?? current.starts_at, endsAt: body.endsAt ?? current.ends_at,
      distanceKm: body.distanceKm ?? current.distance_km, revenueVat: body.revenueVat ?? current.revenue_vat,
      status: body.status ?? current.status, rejectionReason: body.rejectionReason ?? current.rejection_reason,
      temperatureMode: body.temperatureMode ?? current.temperature_mode,
      bodyType: body.bodyType ?? current.body_type
    });
    // Отклонение рейса возвращает заявку в продажи, поэтому причина обязательна.
    if (merged.status === 'rejected' && !String(merged.rejectionReason || '').trim()) {
      return errorJson(response, 422, 'Укажите причину отклонения рейса');
    }
    db.prepare(`UPDATE trips SET vehicle_id=?,order_id=?,customer_name=?,from_zone_id=?,to_zone_id=?,
      from_point=?,to_point=?,starts_at=?,ends_at=?,distance_km=?,revenue_vat=?,status=?,rejection_reason=?,
      temperature_mode=?,body_type=?,updated_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(
      merged.vehicleId, merged.orderId, merged.customerName, merged.fromZoneId, merged.toZoneId,
      merged.fromPoint, merged.toPoint,
      merged.startsAt, merged.endsAt, merged.distanceKm, merged.revenueVat, merged.status,
      merged.rejectionReason, merged.temperatureMode, merged.bodyType, user.id, match[0]);
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
    queueOutbox(db, 'trips', match[0], 'delete', { externalId: current.external_id },
      integrationPublic().writePolicy === 'automatic');
    audit(db, user, 'delete', 'trip', match[0], {}, requestIp(request));
    return json(response, 200, { ok: true });
  }

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
  const addressPointById = id => id
    ? db.prepare(`SELECT latitude,longitude FROM addresses
        WHERE id=? AND latitude IS NOT NULL`).get(id) || null
    : null;

  // Позиция сцепки перед моментом: точка выгрузки последнего рейса ЛИБО
  // место ремонта, если ремонт с адресом был позже выгрузки.
  function vehiclePositionBefore(vehicleId, beforeIso, excludeTripId = '') {
    const prevTrip = db.prepare(`SELECT t.to_point, z.name to_zone_name, t.ends_at
      FROM trips t JOIN zones z ON z.id=t.to_zone_id
      WHERE t.vehicle_id=? AND t.status<>'rejected' AND t.id<>? AND t.starts_at<?
      ORDER BY t.ends_at DESC LIMIT 1`).get(vehicleId, excludeTripId, beforeIso);
    const prevRepair = db.prepare(`SELECT d.ends_at, a.latitude, a.longitude
      FROM vehicle_dispositions d JOIN addresses a ON a.id=d.address_id
      WHERE d.vehicle_id=? AND d.kind='repair' AND a.latitude IS NOT NULL AND d.starts_at<?
      ORDER BY d.ends_at DESC LIMIT 1`).get(vehicleId, beforeIso);
    if (prevRepair && (!prevTrip || prevRepair.ends_at >= prevTrip.ends_at)) {
      return { latitude: prevRepair.latitude, longitude: prevRepair.longitude };
    }
    if (prevTrip) return addressPointByText(prevTrip.to_point || prevTrip.to_zone_name);
    return null;
  }

  // Порожний подгон: от позиции сцепки до пункта погрузки (адрес заявки
  // приоритетнее текста). null — пункт не распознан, а не ноль.
  function emptyKmFor(vehicleId, startsAtIso, fromAddressId, fromText, excludeTripId = '') {
    const origin = vehiclePositionBefore(vehicleId, startsAtIso, excludeTripId);
    const target = addressPointById(fromAddressId) || addressPointByText(fromText);
    if (!origin || !target) return null;
    return roadKm(origin.latitude, origin.longitude, target.latitude, target.longitude);
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

  if (request.method === 'GET' && pathname === '/api/addresses') {
    if (!requireUser(request, response)) return;
    return json(response, 200, {
      items: db.prepare(`SELECT a.*,z.name zone_name FROM addresses a
        LEFT JOIN zones z ON z.id=a.zone_id ORDER BY a.name`).all()
    });
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
    const latitude = Number.isFinite(Number(body.latitude)) && body.latitude !== ''
      ? Number(body.latitude) : null;
    const longitude = Number.isFinite(Number(body.longitude)) && body.longitude !== ''
      ? Number(body.longitude) : null;
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
    for (const key of ['customerName', 'fromZoneId', 'toZoneId', 'windowFrom', 'windowTo']) {
      if (!body[key]) return errorJson(response, 422, `Поле ${key} обязательно`);
    }
    const windowFrom = Date.parse(body.windowFrom);
    const windowTo = Date.parse(body.windowTo);
    if (!Number.isFinite(windowFrom) || !Number.isFinite(windowTo) || windowTo <= windowFrom) {
      return errorJson(response, 422, 'Некорректное окно заявки');
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
      db.prepare(`UPDATE trips SET revenue_vat=?,cash=?,order_no=?,updated_by=?,updated_at=CURRENT_TIMESTAMP
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
    db.exec('BEGIN IMMEDIATE');
    try {
      const assignEmptyKm = emptyKmFor(vehicle.id, startsAt,
        order.from_address_id, order.from_point || null, tripId);
      if (order.trip_id) {
        db.prepare(`UPDATE trips SET vehicle_id=?,status='plan',cash=?,order_no=?,empty_km=?,
          updated_by=?,updated_at=CURRENT_TIMESTAMP
          WHERE id=?`).run(vehicle.id, Number(order.cash || 0), order.order_no || '',
          assignEmptyKm, user.id, tripId);
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
    const tripId = assignOrderCore(order, vehicle, user, { distanceKm: body.distanceKm });
    // Назначение из вкладки «Логист» подтверждается автоматически (логист
    // назначил сам — подтверждать себя не нужно) и сразу уходит диспетчеру.
    // Назначение из продаж логист обязан подтвердить вручную.
    if (body.autoConfirm) confirmAssigned(tripId, order, vehicle, user);
    audit(db, user, 'assign', 'order', order.id,
      { vehicleId: vehicle.id, tripId, autoConfirm: Boolean(body.autoConfirm) }, requestIp(request));
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
    db.prepare(`INSERT INTO drivers(id,full_name,phone,note) VALUES(?,?,?,?)`).run(
      id, name, String(body.phone || '').trim(), String(body.note || '').trim());
    audit(db, user, 'create', 'driver', id, body, requestIp(request));
    return json(response, 201, { id });
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
      db.prepare(`UPDATE drivers SET full_name=?,phone=?,status=?,vehicle_id=?,
        absent_from=?,absent_to=?,note=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(
        String(body.fullName ?? current.full_name).trim(),
        String(body.phone ?? current.phone).trim(), status, vehicleId,
        absentFrom, absentTo, String(body.note ?? current.note).trim(), match[0]);
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

  if (request.method === 'POST' && pathname === '/api/vehicles') {
    const user = requirePermission(request, response, 'fleet:write');
    if (!user) return;
    const body = await readJson(request);
    if (!body.plate || !body.typeId) return errorJson(response, 422, 'Номер и тип обязательны');
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
    const after = Number(url.searchParams.get('after') || 0);
    const items = after > 0
      ? db.prepare('SELECT * FROM messages WHERE id>? ORDER BY id LIMIT 200').all(after)
      : db.prepare('SELECT * FROM (SELECT * FROM messages ORDER BY id DESC LIMIT 40) ORDER BY id').all();
    const lastId = db.prepare('SELECT MAX(id) id FROM messages').get().id || 0;
    return json(response, 200, { items, lastId });
  }
  if (request.method === 'POST' && pathname === '/api/messages') {
    const user = requireUser(request, response);
    if (!user) return;
    const body = await readJson(request);
    const text = String(body.text || '').trim().slice(0, 500);
    if (!text) return errorJson(response, 422, 'Пустое сообщение');
    db.prepare(`INSERT INTO messages(author_id,author_name,kind,text)
      VALUES(?,?,'user',?)`).run(user.id, user.full_name || user.username, text);
    return json(response, 201, { ok: true });
  }

  // ── Шаг диспетчеризации: подтверждение логиста и чек-лист диспетчера ──
  match = route(/^\/api\/trips\/([^/]+)\/step$/, pathname);
  if (match && request.method === 'POST') {
    const body = await readJson(request);
    const meta = DISPATCH_STEPS.find(item => item.step === body.step);
    if (!meta) return errorJson(response, 422, 'Неизвестный шаг диспетчеризации');
    const user = requirePermission(request, response, meta.permission);
    if (!user) return;
    // Фактическое время события (если отмечают позже) — иначе «сейчас».
    const factAt = body.at && Number.isFinite(Date.parse(body.at))
      ? new Date(Date.parse(body.at)).toISOString() : null;
    try {
      const { trip, statusChanged } = applyDispatchStep(db, match[0], body.step, user.id, factAt);
      if (statusChanged) {
        queueOutbox(db, 'trips', match[0], 'update', tripOutboxPayload(match[0]),
          integrationPublic().writePolicy === 'automatic');
      }
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

  if (request.method === 'GET' && pathname === '/api/admin/users') {
    const user = requirePermission(request, response, 'users:write');
    if (!user) return;
    return json(response, 200, {
      roles: ROLE_LABELS,
      items: db.prepare(`SELECT id,username,full_name,email,role,roles,active,created_at,updated_at
        FROM users ORDER BY active DESC,full_name`).all()
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
    db.prepare(`INSERT INTO users(id,username,full_name,email,password_hash,role,roles,active)
      VALUES(?,?,?,?,?,?,?,?)`).run(
      id, body.username.trim(), body.fullName.trim(), body.email || null,
      hashPassword(body.password || ''), roles[0], JSON.stringify(roles), body.active === false ? 0 : 1);
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
    const nextRoles = parseRoles(body);
    if (nextRoles === null) return errorJson(response, 422, 'Нужна хотя бы одна корректная роль');
    if (body.password !== undefined && String(body.password).length < 10) {
      return errorJson(response, 422, 'Пароль должен содержать не менее 10 символов');
    }
    const currentRoles = rolesOf(current);
    const removesActiveAdmin = currentRoles.includes('admin') && current.active &&
      (body.active === false || (nextRoles !== undefined && !nextRoles.includes('admin')));
    if (removesActiveAdmin) {
      const otherAdmins = db.prepare(`SELECT COUNT(*) count FROM users, json_each(users.roles)
        WHERE json_each.value='admin' AND users.active=1 AND users.id<>?`).get(match[0]).count;
      if (!otherAdmins) return errorJson(response, 422, 'В системе должен остаться хотя бы один активный администратор');
    }
    const finalRoles = nextRoles ?? currentRoles;
    db.prepare(`UPDATE users SET username=?,full_name=?,email=?,role=?,roles=?,active=?,
      password_hash=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(
      body.username ?? current.username, body.fullName ?? current.full_name,
      body.email ?? current.email, finalRoles[0], JSON.stringify(finalRoles),
      body.active === undefined ? current.active : Number(Boolean(body.active)),
      body.password ? hashPassword(body.password) : current.password_hash, match[0]);
    if (body.password || body.active === false) db.prepare('DELETE FROM sessions WHERE user_id=?').run(match[0]);
    audit(db, user, 'update', 'user', match[0], { ...body, password: undefined }, requestIp(request));
    return json(response, 200, { ok: true });
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
    for (const key of ['general', 'calculation', 'statuses', 'rejectionReasons', 'orderOptions', 'networkAccess']) {
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
