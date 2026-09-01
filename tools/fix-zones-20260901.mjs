// Починка данных по разбору 01.09: кривые зоны справочника и ошибочная
// выгрузка т553ве58. Каждая правка — в audit_log.
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
const db = new DatabaseSync(process.env.DATABASE_PATH || '/app/data/planner.db');
const admin = db.prepare(`SELECT id FROM users WHERE role='admin' LIMIT 1`).get();
const log = (action, entity, entityId, details) =>
  db.prepare(`INSERT INTO audit_log(id,user_id,action,entity,entity_id,details_json,ip,created_at)
    VALUES(?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`)
    .run(randomUUID(), admin?.id || null, action, entity, entityId,
      JSON.stringify({ ...details, by: 'Claude, разбор геозон 01.09 по указанию руководителя' }), 'local');

const east = db.prepare(`SELECT id FROM zones WHERE name='Восток'`).get().id;
const out = { fixed: [] };

// 1. Адрес «Омская обл., Москаленки» Дом → Восток + заявка/рейс.
const mosk = db.prepare(`SELECT id, zone_id FROM addresses WHERE name LIKE 'Омская обл.%Москаленки%'`).get();
if (mosk && mosk.zone_id !== east) {
  db.prepare(`UPDATE addresses SET zone_id=? WHERE id=?`).run(east, mosk.id);
  log('update', 'address', mosk.id, { field: 'zone_id', to: 'Восток', was: 'Дом', reason: 'Омская область — Восток' });
  out.fixed.push('адрес Москаленки → Восток');
}
for (const o of db.prepare(`SELECT id, trip_id FROM orders
    WHERE from_point LIKE '%Москаленки%' AND from_zone_id != ?`).all(east)) {
  db.prepare(`UPDATE orders SET from_zone_id=? WHERE id=?`).run(east, o.id);
  log('update', 'order', o.id, { field: 'from_zone_id', to: 'Восток' });
  if (o.trip_id) {
    db.prepare(`UPDATE trips SET from_zone_id=? WHERE id=?`).run(east, o.trip_id);
    log('update', 'trip', o.trip_id, { field: 'from_zone_id', to: 'Восток' });
  }
  out.fixed.push(`заявка ${o.id.slice(0, 8)} (Москаленки) → Восток`);
}

// 2. Адрес «кемерово» Урал → Восток + заявки/рейсы на Кемерово с Уралом.
const kem = db.prepare(`SELECT id, zone_id FROM addresses WHERE name='кемерово' COLLATE NOCASE`).get();
if (kem && kem.zone_id !== east) {
  db.prepare(`UPDATE addresses SET zone_id=? WHERE id=?`).run(east, kem.id);
  log('update', 'address', kem.id, { field: 'zone_id', to: 'Восток', was: 'Урал', reason: 'Кемерово — алиас зоны Восток' });
  out.fixed.push('адрес «кемерово» → Восток');
}
for (const o of db.prepare(`SELECT id, trip_id FROM orders
    WHERE to_point LIKE '%емерово%' AND to_zone_id != ?`).all(east)) {
  db.prepare(`UPDATE orders SET to_zone_id=? WHERE id=?`).run(east, o.id);
  log('update', 'order', o.id, { field: 'to_zone_id', to: 'Восток' });
  if (o.trip_id) {
    db.prepare(`UPDATE trips SET to_zone_id=? WHERE id=?`).run(east, o.trip_id);
    log('update', 'trip', o.trip_id, { field: 'to_zone_id', to: 'Восток' });
  }
  out.fixed.push(`заявка ${o.id.slice(0, 8)} (Кемерово) → Восток`);
}

// 3. т553ве58: рейс в Кемерово возвращён в путь — выгрузка 31.08 была
// ошибочной отметкой (машина физически едет, план выгрузки 03.09).
const trip553 = '3bd5fe6b-2078-4476-bf3a-f31f02a91508';
const cur = db.prepare(`SELECT status, unloaded_at, arrived_at, order_id FROM trips WHERE id=?`).get(trip553);
if (cur && cur.status === 'unloaded') {
  db.prepare(`UPDATE trips SET status='run', unloaded_at=NULL, arrived_at=NULL,
    docs_checked_at=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(trip553);
  const stopCols = db.prepare(`SELECT name FROM pragma_table_info('trip_stops')`).all().map(r => r.name);
  const factCols = ['actual_arrival', 'work_started_at', 'work_finished_at', 'actual_departure']
    .filter(c => stopCols.includes(c));
  if (factCols.length) {
    db.prepare(`UPDATE trip_stops SET ${factCols.map(c => `${c}=NULL`).join(',')}
      WHERE trip_id=? AND kind='D'`).run(trip553);
  }
  if (cur.order_id) db.prepare(`UPDATE orders SET stage=3 WHERE id=? AND stage>3`).run(cur.order_id);
  log('update', 'trip', trip553, { action: 'вернул в путь', was: { status: cur.status,
    unloaded_at: cur.unloaded_at, arrived_at: cur.arrived_at },
    reason: 'выгрузка отмечена 31.08 через 31 ч после вывода на линию — до Кемерово 3700 км, физически невозможно; план выгрузки 03.09' });
  out.fixed.push('т553ве58: рейс в Кемерово возвращён в статус «В пути», отметки прибытия/выгрузки сняты');
}

// 4. Ревизия справочника: адреса, где алиас в городской части имени
// (первая часть до запятой) указывает другую зону — СПИСОК без правки.
const aliasRows = db.prepare(`SELECT z.id, z.name AS zone, z.name AS alias FROM zones z
  UNION ALL SELECT a.zone_id AS id, z2.name AS zone, a.alias FROM zone_aliases a
  JOIN zones z2 ON z2.id = a.zone_id`).all();
out.suspects = [];
for (const a of db.prepare(`SELECT a.id, a.name, z.name AS zone FROM addresses a
    LEFT JOIN zones z ON z.id = a.zone_id`).all()) {
  const head = String(a.name).split(',')[0].toLowerCase();
  const hits = aliasRows.filter(r => {
    const al = r.alias.toLowerCase();
    if (al.length >= 5) return head.includes(al);
    return new RegExp(`(^|[^а-яёa-z])${al}([^а-яёa-z]|$)`, 'i').test(head);
  }).sort((x, y) => y.alias.length - x.alias.length);
  if (hits.length && hits[0].zone !== a.zone) {
    out.suspects.push({ name: a.name, zone: a.zone || '—', shouldBe: hits[0].zone, byAlias: hits[0].alias });
  }
}
console.log('Исправлено:');
for (const line of out.fixed) console.log(' ✔', line);
if (!out.fixed.length) console.log(' — нечего исправлять (уже поправлено)');
console.log('\nПодозрительные зоны справочника (без правки, на решение руководителя):');
for (const s of out.suspects) console.log(` ⚠ ${s.name} — сейчас «${s.zone}», по алиасу «${s.byAlias}» должна быть «${s.shouldBe}»`);
if (!out.suspects.length) console.log(' — расхождений не найдено');
