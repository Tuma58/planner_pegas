import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config } from './config.mjs';
import { audit, openDatabase, queueOutbox, settingsObject } from './db.mjs';
import { ipInSubnets, normalizeAllowedSubnets } from './network-access.mjs';
import { ROLE_LABELS, hasPermission, permissionsFor } from './permissions.mjs';
import {
  encryptSecret, hashPassword, newSessionToken, parseCookies, tokenHash, verifyPassword
} from './security.mjs';
import { processOutbox, runPull, startIntegrationScheduler, testConnection } from './odata.mjs';
import {
  importTelematics, importTripsFrom1C, reportSnapshot, resolveZone
} from './planner-service.mjs';

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
  const forwarded = trustedForwarding(request) ? String(request.headers['x-real-ip'] || '') : '';
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
  return {
    id: user.id, username: user.username, fullName: user.full_name, email: user.email || '',
    role: user.role, roleLabel: ROLE_LABELS[user.role], active: Boolean(user.active),
    permissions: permissionsFor(user.role)
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
  const forwarded = trustedForwarding(request)
    ? String(request.headers['x-forwarded-proto'] || '').toLowerCase() : '';
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
  return db.prepare(`SELECT t.*,v.plate vehicle_plate,v.trailer_plate,vt.name vehicle_type,
    f.name from_name,f.color from_color,d.name to_name,d.color to_color
    FROM trips t JOIN vehicles v ON v.id=t.vehicle_id
    JOIN vehicle_types vt ON vt.id=v.type_id JOIN zones f ON f.id=t.from_zone_id
    JOIN zones d ON d.id=t.to_zone_id
    WHERE (?='' OR t.starts_at<=? AND t.ends_at>=?)
    ORDER BY t.starts_at`).all(search, search, search);
}

function listOrders() {
  return db.prepare(`SELECT o.*,f.name from_name,t.name to_name
    FROM orders o JOIN zones f ON f.id=o.from_zone_id JOIN zones t ON t.id=o.to_zone_id
    WHERE o.status<>'cancelled' ORDER BY o.window_from`).all();
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
    return json(response, 200, { ok: true, database: Boolean(db.prepare('SELECT 1 AS ok').get().ok) });
  }

  if (request.method === 'GET' && pathname === '/api/bootstrap') {
    const user = requireUser(request, response);
    if (!user) return;
    return json(response, 200, {
      user: publicUser(user), settings: plannerSettings(), reference: allReferenceData(),
      vehicles: listVehicles(), trips: listTrips(url.searchParams.get('date') || ''),
      orders: listOrders(), dispositions: listDispositions(),
      revenuePlans: db.prepare('SELECT * FROM revenue_plans ORDER BY period_start').all()
    });
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
      starts_at,ends_at,distance_km,revenue_vat,status,rejection_reason,temperature_mode,
      body_type,created_by,updated_by)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, trip.vehicleId, trip.orderId, trip.customerName, trip.fromZoneId, trip.toZoneId,
      trip.startsAt, trip.endsAt, trip.distanceKm, trip.revenueVat, trip.status,
      trip.rejectionReason, trip.temperatureMode, trip.bodyType, user.id, user.id);
    if (trip.orderId) db.prepare(`UPDATE orders SET status='planned',stage=2,trip_id=?,
      assigned_vehicle_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(id, trip.vehicleId, trip.orderId);
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
      startsAt: body.startsAt ?? current.starts_at, endsAt: body.endsAt ?? current.ends_at,
      distanceKm: body.distanceKm ?? current.distance_km, revenueVat: body.revenueVat ?? current.revenue_vat,
      status: body.status ?? current.status, rejectionReason: body.rejectionReason ?? current.rejection_reason,
      temperatureMode: body.temperatureMode ?? current.temperature_mode,
      bodyType: body.bodyType ?? current.body_type
    });
    db.prepare(`UPDATE trips SET vehicle_id=?,order_id=?,customer_name=?,from_zone_id=?,to_zone_id=?,
      starts_at=?,ends_at=?,distance_km=?,revenue_vat=?,status=?,rejection_reason=?,
      temperature_mode=?,body_type=?,updated_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(
      merged.vehicleId, merged.orderId, merged.customerName, merged.fromZoneId, merged.toZoneId,
      merged.startsAt, merged.endsAt, merged.distanceKm, merged.revenueVat, merged.status,
      merged.rejectionReason, merged.temperatureMode, merged.bodyType, user.id, match[0]);
    if (merged.orderId) {
      const stage = ({ plan: 2, run: 3, unloaded: 4, done: 5, paid: 5, rejected: 1 })[merged.status] || 2;
      db.prepare(`UPDATE orders SET stage=?,status=?,assigned_vehicle_id=?,
        updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(
        stage, merged.status === 'rejected' ? 'new' : 'planned', merged.vehicleId, merged.orderId);
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
    db.prepare('DELETE FROM trips WHERE id=?').run(match[0]);
    queueOutbox(db, 'trips', match[0], 'delete', { externalId: current.external_id },
      integrationPublic().writePolicy === 'automatic');
    audit(db, user, 'delete', 'trip', match[0], {}, requestIp(request));
    return json(response, 200, { ok: true });
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
    const id = randomUUID();
    db.prepare(`INSERT INTO orders(id,customer_name,from_zone_id,to_zone_id,rate_vat,
      window_from,window_to,temperature_mode,body_type,stage,created_by)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, body.customerName.trim(), body.fromZoneId, body.toZoneId, Number(body.rateVat || 0),
      new Date(windowFrom).toISOString(), new Date(windowTo).toISOString(),
      String(body.temperatureMode || ''), String(body.bodyType || ''), Number(body.stage || 0), user.id);
    queueOutbox(db, 'orders', id, 'create', orderOutboxPayload(id),
      integrationPublic().writePolicy === 'automatic');
    audit(db, user, 'create', 'order', id, body, requestIp(request));
    return json(response, 201, { id });
  }
  match = route(/^\/api\/orders\/([^/]+)$/, pathname);
  if (match && request.method === 'PATCH') {
    const user = requirePermission(request, response, 'orders:write');
    if (!user) return;
    const body = await readJson(request);
    const current = db.prepare('SELECT * FROM orders WHERE id=?').get(match[0]);
    if (!current) return errorJson(response, 404, 'Заявка не найдена');
    const starts = Date.parse(body.windowFrom ?? current.window_from);
    const ends = Date.parse(body.windowTo ?? current.window_to);
    if (!Number.isFinite(starts) || !Number.isFinite(ends) || ends <= starts) {
      return errorJson(response, 422, 'Некорректное окно заявки');
    }
    db.prepare(`UPDATE orders SET customer_name=?,from_zone_id=?,to_zone_id=?,rate_vat=?,
      window_from=?,window_to=?,status=?,temperature_mode=?,body_type=?,stage=?,
      updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(
      String(body.customerName ?? current.customer_name).trim(),
      body.fromZoneId ?? current.from_zone_id, body.toZoneId ?? current.to_zone_id,
      Number(body.rateVat ?? current.rate_vat), new Date(starts).toISOString(),
      new Date(ends).toISOString(), body.status ?? current.status,
      String(body.temperatureMode ?? current.temperature_mode),
      String(body.bodyType ?? current.body_type), Number(body.stage ?? current.stage), match[0]);
    queueOutbox(db, 'orders', match[0], 'update', orderOutboxPayload(match[0]),
      integrationPublic().writePolicy === 'automatic');
    audit(db, user, 'update', 'order', match[0], body, requestIp(request));
    return json(response, 200, { ok: true });
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
    const settings = settingsObject(db).calculation;
    const rate = db.prepare(`SELECT distance_km FROM route_rates
      WHERE (from_zone_id=? AND to_zone_id=?) OR (from_zone_id=? AND to_zone_id=?)
      LIMIT 1`).get(order.from_zone_id, order.to_zone_id, order.to_zone_id, order.from_zone_id);
    const distance = Number(body.distanceKm || rate?.distance_km || 500);
    const startsAt = order.window_from;
    const duration = distance / Number(settings.dailyMileageKm || 600) + Number(settings.handlingDays || 0.5);
    const endsAt = new Date(Date.parse(startsAt) + duration * 86_400_000).toISOString();
    const tripId = order.trip_id || randomUUID();
    db.exec('BEGIN IMMEDIATE');
    try {
      if (order.trip_id) {
        db.prepare(`UPDATE trips SET vehicle_id=?,status='plan',updated_by=?,updated_at=CURRENT_TIMESTAMP
          WHERE id=?`).run(vehicle.id, user.id, tripId);
      } else {
        db.prepare(`INSERT INTO trips(id,vehicle_id,order_id,customer_name,from_zone_id,to_zone_id,
          starts_at,ends_at,distance_km,revenue_vat,status,temperature_mode,body_type,created_by,updated_by)
          VALUES(?,?,?,?,?,?,?,?,?,?, 'plan',?,?,?,?)`).run(
          tripId, vehicle.id, order.id, order.customer_name, order.from_zone_id, order.to_zone_id,
          startsAt, endsAt, distance, order.rate_vat, order.temperature_mode, order.body_type, user.id, user.id);
      }
      db.prepare(`UPDATE orders SET status='planned',stage=2,assigned_vehicle_id=?,trip_id=?,
        updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(vehicle.id, tripId, order.id);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    queueOutbox(db, 'trips', tripId, order.trip_id ? 'update' : 'create', tripOutboxPayload(tripId),
      integrationPublic().writePolicy === 'automatic');
    audit(db, user, 'assign', 'order', order.id, { vehicleId: vehicle.id, tripId }, requestIp(request));
    return json(response, 201, { tripId });
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
    audit(db, user, 'update', 'vehicle', match[0], body, requestIp(request));
    return json(response, 200, { ok: true });
  }
  if (request.method === 'POST' && pathname === '/api/dispositions') {
    const user = requirePermission(request, response, 'fleet:write');
    if (!user) return;
    const body = await readJson(request);
    const allowed = new Set(['repair', 'no_driver', 'shift', 'out']);
    if (!body.vehicleId || !allowed.has(body.kind)) {
      return errorJson(response, 422, 'ТС и вид недоступности обязательны');
    }
    const startsAt = Date.parse(body.startsAt);
    const endsAt = Date.parse(body.endsAt);
    if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt) || endsAt <= startsAt) {
      return errorJson(response, 422, 'Некорректный период недоступности');
    }
    const id = randomUUID();
    db.prepare(`INSERT INTO vehicle_dispositions(
      id,vehicle_id,kind,starts_at,ends_at,note,created_by,updated_by)
      VALUES(?,?,?,?,?,?,?,?)`).run(
      id, body.vehicleId, body.kind, new Date(startsAt).toISOString(),
      new Date(endsAt).toISOString(), String(body.note || ''), user.id, user.id);
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
    if (!['repair', 'no_driver', 'shift', 'out'].includes(kind) || endsAt <= startsAt) {
      return errorJson(response, 422, 'Некорректный интервал');
    }
    db.prepare(`UPDATE vehicle_dispositions SET vehicle_id=?,kind=?,starts_at=?,ends_at=?,
      note=?,updated_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(
      body.vehicleId ?? current.vehicle_id, kind, new Date(startsAt).toISOString(),
      new Date(endsAt).toISOString(), String(body.note ?? current.note), user.id, match[0]);
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

  if (request.method === 'GET' && pathname === '/api/exceptions') {
    const user = requirePermission(request, response, 'planner:read');
    if (!user) return;
    const trips = listTrips();
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
    const critical = trips.filter(trip => trip.status !== 'rejected' && dispositions.some(item =>
      item.vehicle_id === trip.vehicle_id &&
      Date.parse(trip.starts_at) < Date.parse(item.ends_at) &&
      Date.parse(item.starts_at) < Date.parse(trip.ends_at)));
    const rejected = trips.filter(trip => trip.status === 'rejected');
    const conflictItems = trips.filter(trip => conflicts.has(trip.id));
    return json(response, 200, {
      count: critical.length + rejected.length + conflictItems.length,
      critical, rejected, conflicts: conflictItems,
      unavailableVehicles: db.prepare(`SELECT status,COUNT(*) count FROM vehicles
        WHERE status<>'work' GROUP BY status`).all()
    });
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
      items: db.prepare(`SELECT id,username,full_name,email,role,active,created_at,updated_at
        FROM users ORDER BY active DESC,full_name`).all()
    });
  }
  if (request.method === 'POST' && pathname === '/api/admin/users') {
    const user = requirePermission(request, response, 'users:write');
    if (!user) return;
    const body = await readJson(request);
    if (!body.username || !body.fullName || !ROLE_LABELS[body.role]) {
      return errorJson(response, 422, 'Логин, имя и корректная роль обязательны');
    }
    if (typeof body.password !== 'string' || body.password.length < 10) {
      return errorJson(response, 422, 'Пароль должен содержать не менее 10 символов');
    }
    const id = randomUUID();
    db.prepare(`INSERT INTO users(id,username,full_name,email,password_hash,role,active)
      VALUES(?,?,?,?,?,?,?)`).run(
      id, body.username.trim(), body.fullName.trim(), body.email || null,
      hashPassword(body.password || ''), body.role, body.active === false ? 0 : 1);
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
    if (body.role !== undefined && !ROLE_LABELS[body.role]) return errorJson(response, 422, 'Неизвестная роль');
    if (body.password !== undefined && String(body.password).length < 10) {
      return errorJson(response, 422, 'Пароль должен содержать не менее 10 символов');
    }
    const removesActiveAdmin = current.role === 'admin' && current.active &&
      (body.active === false || (body.role !== undefined && body.role !== 'admin'));
    if (removesActiveAdmin) {
      const otherAdmins = db.prepare(`SELECT COUNT(*) count FROM users
        WHERE role='admin' AND active=1 AND id<>?`).get(match[0]).count;
      if (!otherAdmins) return errorJson(response, 422, 'В системе должен остаться хотя бы один активный администратор');
    }
    db.prepare(`UPDATE users SET username=?,full_name=?,email=?,role=?,active=?,
      password_hash=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(
      body.username ?? current.username, body.fullName ?? current.full_name,
      body.email ?? current.email, body.role ?? current.role,
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

function staticFile(request, response, url) {
  let pathname = url.pathname === '/' ? '/login.html' : url.pathname;
  if (pathname === '/planner') pathname = '/app.html';
  if (pathname === '/settings') pathname = '/settings.html';
  const resolved = path.resolve(config.publicPath, `.${pathname}`);
  if (!resolved.startsWith(`${config.publicPath}${path.sep}`)) return errorJson(response, 403, 'Запрещено');
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return errorJson(response, 404, 'Страница не найдена');
  const content = fs.readFileSync(resolved);
  response.writeHead(200, {
    'Content-Type': MIME[path.extname(resolved)] || 'application/octet-stream',
    'Content-Length': content.length,
    'Cache-Control': config.isProduction ? 'public, max-age=3600' : 'no-cache'
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
