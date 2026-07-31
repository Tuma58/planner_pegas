import { randomUUID } from 'node:crypto';
import { decryptSecret } from './security.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function joinUrl(base, part) {
  return `${base.replace(/\/+$/, '')}/${String(part).replace(/^\/+/, '')}`;
}

function validateHttpUrl(value) {
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('OData URL должен использовать HTTP или HTTPS');
  return parsed;
}

function nestedValue(source, path) {
  return String(path).split('.').reduce((value, key) => value?.[key], source);
}

function mapRecord(source, mapping) {
  return Object.fromEntries(Object.entries(mapping)
    .map(([local, remote]) => [local, nestedValue(source, remote)])
    .filter(([, value]) => value !== undefined));
}

function resolveZone(db, value) {
  if (!value) return null;
  return db.prepare(`SELECT id FROM zones WHERE external_id=? OR name=? COLLATE NOCASE
    UNION ALL SELECT z.id FROM zone_aliases a JOIN zones z ON z.id=a.zone_id
    WHERE a.alias=? COLLATE NOCASE LIMIT 1`)
    .get(String(value), String(value), String(value))?.id || null;
}

function resolveVehicle(db, value) {
  if (!value) return null;
  return db.prepare('SELECT id FROM vehicles WHERE external_id=? OR plate=? COLLATE NOCASE LIMIT 1')
    .get(String(value), String(value))?.id || null;
}

function odataHeaders(config, secret, extra = {}) {
  const encoded = Buffer.from(`${config.username}:${decryptSecret(config.password_cipher, secret)}`).toString('base64');
  return {
    Accept: 'application/json',
    Authorization: `Basic ${encoded}`,
    'OData-Version': '4.0',
    ...extra
  };
}

export async function testConnection(config, secret) {
  if (!config.base_url) throw new Error('Не указан URL OData');
  validateHttpUrl(config.base_url);
  const response = await fetch(joinUrl(config.base_url, '$metadata'), {
    headers: odataHeaders(config, secret),
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error(`1С ответила HTTP ${response.status}`);
  return { ok: true, status: response.status };
}

async function fetchCollection(config, secret, entitySet, filterQuery = '') {
  let url = joinUrl(config.base_url, entitySet);
  const allowedOrigin = validateHttpUrl(config.base_url).origin;
  if (filterQuery) url += (filterQuery.startsWith('?') ? filterQuery : `?${filterQuery}`);
  const records = [];
  let pages = 0;
  while (url && pages < 500) {
    const response = await fetch(url, {
      headers: odataHeaders(config, secret),
      signal: AbortSignal.timeout(30_000)
    });
    if (!response.ok) throw new Error(`${entitySet}: HTTP ${response.status}`);
    const data = await response.json();
    records.push(...(Array.isArray(data.value) ? data.value : []));
    url = data['@odata.nextLink'] || '';
    if (url && new URL(url, config.base_url).origin !== allowedOrigin) {
      throw new Error('1С вернула nextLink на недопустимый хост');
    }
    if (url) url = new URL(url, config.base_url).toString();
    pages += 1;
  }
  return records;
}

export function upsertPulled(db, entity, record) {
  if (entity === 'vehicles' && record.externalId && record.plate) {
    const defaultType = db.prepare('SELECT id FROM vehicle_types ORDER BY name LIMIT 1').get();
    const defaultZone = db.prepare('SELECT id FROM zones ORDER BY sort_order LIMIT 1').get();
    const existing = db.prepare('SELECT id FROM vehicles WHERE external_id=? OR plate=? COLLATE NOCASE LIMIT 1')
      .get(record.externalId, record.plate);
    if (existing) {
      db.prepare(`UPDATE vehicles SET plate=?,driver_name=?,trailer_plate=?,external_id=?,
        updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(
        record.plate, record.driverName || '', record.trailerPlate || '', record.externalId, existing.id);
    } else {
      db.prepare(`INSERT INTO vehicles(
        id,plate,type_id,driver_name,trailer_plate,zone_id,external_id,updated_at)
        VALUES(?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`).run(
        randomUUID(), record.plate, defaultType.id, record.driverName || '',
        record.trailerPlate || '', defaultZone.id, record.externalId);
    }
    return 1;
  }
  if (entity === 'customers' && record.externalId && record.name) {
    const existing = db.prepare('SELECT id FROM customers WHERE external_id=? OR name=? COLLATE NOCASE LIMIT 1')
      .get(record.externalId, record.name);
    if (existing) {
      db.prepare(`UPDATE customers SET name=?,external_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(record.name, record.externalId, existing.id);
    } else {
      db.prepare(`INSERT INTO customers(id,name,external_id,updated_at)
        VALUES(?,?,?,CURRENT_TIMESTAMP)`).run(randomUUID(), record.name, record.externalId);
    }
    return 1;
  }
  if (entity === 'orders' && record.externalId) {
    const fromZone = resolveZone(db, record.fromZone);
    const toZone = resolveZone(db, record.toZone);
    if (!fromZone || !toZone || !record.windowFrom || !record.windowTo) return 0;
    const existing = db.prepare('SELECT id FROM orders WHERE external_id=?').get(record.externalId);
    const status = ['new', 'planned', 'cancelled'].includes(record.status) ? record.status : 'new';
    if (existing) {
      db.prepare(`UPDATE orders SET customer_name=?,from_zone_id=?,to_zone_id=?,rate_vat=?,
        window_from=?,window_to=?,status=?,temperature_mode=?,body_type=?,external_etag=?,
        updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(
        record.customerName || '', fromZone, toZone, Number(record.rateVat || 0),
        new Date(record.windowFrom).toISOString(), new Date(record.windowTo).toISOString(),
        status, record.temperatureMode || '', record.bodyType || '', record.etag || null, existing.id);
    } else {
      db.prepare(`INSERT INTO orders(id,customer_name,from_zone_id,to_zone_id,rate_vat,
        window_from,window_to,status,temperature_mode,body_type,external_id,external_etag)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        randomUUID(), record.customerName || '', fromZone, toZone, Number(record.rateVat || 0),
        new Date(record.windowFrom).toISOString(), new Date(record.windowTo).toISOString(),
        status, record.temperatureMode || '', record.bodyType || '', record.externalId, record.etag || null);
    }
    return 1;
  }
  if (entity === 'trips' && record.externalId) {
    const vehicle = resolveVehicle(db, record.vehicle);
    const fromZone = resolveZone(db, record.fromZone);
    const toZone = resolveZone(db, record.toZone);
    if (!vehicle || !fromZone || !toZone || !record.startsAt || !record.endsAt) return 0;
    const existing = db.prepare('SELECT id FROM trips WHERE external_id=?').get(record.externalId);
    const status = ({ plan: 'plan', run: 'run', unl: 'unloaded', unloaded: 'unloaded',
      done: 'done', pay: 'paid', paid: 'paid', rej: 'rejected', rejected: 'rejected' })[record.status] || 'plan';
    const values = [
      vehicle, record.customerName || '', fromZone, toZone,
      new Date(record.startsAt).toISOString(), new Date(record.endsAt).toISOString(),
      Number(record.distanceKm || 0), Number(record.revenueVat || 0), status,
      record.externalId, record.etag || null, record.temperatureMode || '', record.bodyType || ''
    ];
    if (existing) {
      db.prepare(`UPDATE trips SET vehicle_id=?,customer_name=?,from_zone_id=?,to_zone_id=?,
        starts_at=?,ends_at=?,distance_km=?,revenue_vat=?,status=?,external_id=?,external_etag=?,
        temperature_mode=?,body_type=?,source_system='1c',updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(...values, existing.id);
    } else {
      db.prepare(`INSERT INTO trips(id,vehicle_id,customer_name,from_zone_id,to_zone_id,
        starts_at,ends_at,distance_km,revenue_vat,status,external_id,external_etag,
        temperature_mode,body_type,source_system)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?, '1c')`).run(randomUUID(), ...values);
    }
    return 1;
  }
  return 0;
}

export async function runPull(db, secret, onlyEntity = null, force = false) {
  const integration = db.prepare('SELECT * FROM integration_config WHERE id=1').get();
  if (!integration.enabled && !force) return null;
  db.prepare(`UPDATE sync_jobs SET status='failed',finished_at=CURRENT_TIMESTAMP,
    error_text='Прервано при перезапуске службы'
    WHERE status='running' AND datetime(started_at)<datetime('now','-1 hour')`).run();
  const jobId = randomUUID();
  try {
    db.prepare(`INSERT INTO sync_jobs(id,kind,status,started_at) VALUES(?, 'pull', 'running', ?)`)
      .run(jobId, new Date().toISOString());
  } catch (error) {
    if (String(error.message).includes('UNIQUE constraint')) {
      return db.prepare(`SELECT id FROM sync_jobs WHERE status='running' ORDER BY started_at DESC LIMIT 1`).get()?.id;
    }
    throw error;
  }
  let pulled = 0;
  try {
    const mappings = db.prepare(`
      SELECT * FROM integration_mappings
      WHERE enabled=1 AND direction IN ('pull','both')`).all()
      .filter(mapping => !onlyEntity || mapping.entity === onlyEntity);
    for (const mapping of mappings) {
      const rows = await fetchCollection(
        integration, secret, mapping.entity_set, mapping.filter_query);
      const fieldMap = JSON.parse(mapping.field_map_json);
      db.exec('BEGIN');
      try {
        for (const source of rows) pulled += upsertPulled(db, mapping.entity, mapRecord(source, fieldMap));
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
    db.prepare(`UPDATE sync_jobs SET status='done',finished_at=?,pulled=? WHERE id=?`)
      .run(new Date().toISOString(), pulled, jobId);
    db.prepare('UPDATE integration_config SET last_success_at=? WHERE id=1')
      .run(new Date().toISOString());
  } catch (error) {
    db.prepare(`UPDATE sync_jobs SET status='failed',finished_at=?,pulled=?,error_text=? WHERE id=?`)
      .run(new Date().toISOString(), pulled, String(error.message || error), jobId);
  }
  return jobId;
}

function reverseMap(local, fieldMap) {
  return Object.fromEntries(Object.entries(fieldMap)
    .filter(([localName]) => !['externalId', 'externalEtag', 'etag'].includes(localName) && local[localName] !== undefined)
    .map(([localName, remoteName]) => [remoteName, local[localName]]));
}

function saveExternalReference(db, entity, entityId, responseData, response) {
  const table = { trips: 'trips', orders: 'orders', vehicles: 'vehicles', customers: 'customers' }[entity];
  if (!table) return;
  const location = response.headers.get('location') || '';
  const locationMatch = location.match(/guid'([^']+)'/i);
  const externalId = responseData?.Ref_Key || responseData?.ref_key || locationMatch?.[1];
  const etag = response.headers.get('etag') || responseData?.['@odata.etag'];
  if (!externalId && !etag) return;
  db.prepare(`UPDATE ${table} SET external_id=COALESCE(?,external_id),
    external_etag=COALESCE(?,external_etag),updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(externalId || null, etag || null, entityId);
}

export async function processOutbox(db, secret, limit = 20) {
  const integration = db.prepare('SELECT * FROM integration_config WHERE id=1').get();
  if (!integration.enabled || !integration.write_enabled) return { pushed: 0 };
  const items = db.prepare(`
    SELECT * FROM outbox
    WHERE status IN ('approved','failed') AND (next_attempt_at IS NULL OR next_attempt_at <= CURRENT_TIMESTAMP)
    ORDER BY created_at LIMIT ?`).all(limit);
  let pushed = 0;
  for (const item of items) {
    const mapping = db.prepare(`
      SELECT * FROM integration_mappings
      WHERE entity=? AND enabled=1 AND direction IN ('push','both')`).get(item.entity);
    if (!mapping) continue;
    const claimed = db.prepare(`UPDATE outbox SET status='processing',attempts=attempts+1,
      updated_at=CURRENT_TIMESTAMP WHERE id=? AND status IN ('approved','failed')`).run(item.id);
    if (!claimed.changes) continue;
    try {
      const local = { ...JSON.parse(item.payload_json), idempotencyKey: item.idempotency_key };
      const remote = reverseMap(local, JSON.parse(mapping.field_map_json));
      // Если в конфигурации 1С есть отдельный реквизит IntegrationKey, его стоит
      // сопоставить с idempotencyKey. Это защищает POST от дублей при сетевых повторах.
      const externalId = local.externalId;
      const target = externalId
        ? `${mapping.entity_set}(guid'${encodeURIComponent(externalId)}')`
        : mapping.entity_set;
      const method = externalId ? 'PATCH' : 'POST';
      if (item.operation === 'delete') {
        if (!externalId) {
          db.prepare(`UPDATE outbox SET status='sent',last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
            .run(item.id);
          pushed += 1;
          continue;
        }
        remote.DeletionMark = true;
      }
      const response = await fetch(joinUrl(integration.base_url, target), {
        method,
        headers: odataHeaders(integration, secret, {
          'Content-Type': 'application/json',
          'Idempotency-Key': item.idempotency_key,
          Prefer: 'return=representation',
          ...(externalId && local.externalEtag ? { 'If-Match': local.externalEtag } : {})
        }),
        body: JSON.stringify(remote),
        signal: AbortSignal.timeout(30_000)
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
      let responseData = null;
      try {
        const text = await response.text();
        if (text) responseData = JSON.parse(text);
      } catch {}
      saveExternalReference(db, item.entity, item.entity_id, responseData, response);
      db.prepare(`UPDATE outbox SET status='sent',last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(item.id);
      pushed += 1;
    } catch (error) {
      const attempts = item.attempts + 1;
      const delayMinutes = Math.min(60, 2 ** Math.min(attempts, 6));
      db.prepare(`UPDATE outbox SET status='failed',last_error=?,
        next_attempt_at=datetime('now', ?),updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(String(error.message || error), `+${delayMinutes} minutes`, item.id);
    }
    await sleep(25);
  }
  return { pushed };
}

export function startIntegrationScheduler(db, secret) {
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const integration = db.prepare('SELECT * FROM integration_config WHERE id=1').get();
      const due = !integration.last_success_at ||
        Date.now() - Date.parse(integration.last_success_at) >= integration.pull_interval_min * 60_000;
      if (integration.enabled && due) await runPull(db, secret);
      await processOutbox(db, secret);
    } finally {
      busy = false;
    }
  }, 60_000);
  timer.unref();
  return timer;
}
