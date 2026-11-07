// Чек-лист продукта 07.11: «Документы» после выгрузки и журнал БДД.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../src/db.mjs';
import { docsBoard, docsNorm, markDocs } from '../src/trip-docs.mjs';
import { addSafetyEvent, closeSafetyEvent, safetyBoard } from '../src/safety.mjs';
import { accessOf, assignRoleSets } from '../src/access.mjs';
import { createStaffUser } from '../src/staff.mjs';
import { hashPassword } from '../src/security.mjs';

function freshDb(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pegas-docs-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = openDatabase(path.join(directory, 'planner.db'), {
    username: 'root-admin', password: 'Temporary-password-2026', fullName: 'Администратор'
  });
  t.after(() => db.close());
  return db;
}
function trip(db, status, unloadedAt) {
  const vehicle = db.prepare(`SELECT id FROM vehicles LIMIT 1`).get();
  const zones = db.prepare('SELECT id FROM zones LIMIT 2').all();
  const id = randomUUID();
  db.prepare(`INSERT INTO trips(id,vehicle_id,from_zone_id,to_zone_id,starts_at,ends_at,distance_km,revenue_vat,status,unloaded_at)
    VALUES(?,?,?,?,?,?,500,100000,?,?)`).run(id, vehicle.id, zones[0].id, zones[1].id, unloadedAt, unloadedAt, status, unloadedAt);
  return id;
}

test('документы: учёт с момента включения, отметка после выгрузки, живой норматив', t => {
  const db = freshDb(t);
  const since = db.prepare(`SELECT value FROM app_meta WHERE key='docs_return_since'`).get().value;
  const before = trip(db, 'done', new Date(Date.parse(since) - 864e5).toISOString()); // старый — задачей не всплывает
  const now = Date.now();
  const waiting = trip(db, 'unloaded', new Date(Date.parse(since) + 1000).toISOString());
  const planned = trip(db, 'plan', new Date(now + 864e5).toISOString());
  let board = docsBoard(db, now + 60_000);
  assert.deepEqual(board.items.map(item => item.id), [waiting]);
  assert.equal(board.norm, null); // фактов мало — норматива нет
  assert.equal(markDocs(db, planned, 'originals', 'Учёт').ok, false); // до выгрузки нельзя
  assert.equal(markDocs(db, waiting, 'нет', 'Учёт').ok, false);
  assert.ok(markDocs(db, waiting, 'etrn', 'Учёт').ok);
  assert.equal(markDocs(db, waiting, 'etrn', 'Учёт').ok, false); // повторно — нет
  board = docsBoard(db, now + 60_000);
  assert.equal(board.items.length, 0);
  assert.equal(board.summary.returnedWeek, 1);
  assert.ok(before);
  assert.equal(docsNorm(db, now), null);
});

test('журнал БДД: ДТП требует описания, расследование закрывается мерами, сроки допусков', t => {
  const db = freshDb(t);
  const driver = db.prepare(`SELECT id FROM drivers LIMIT 1`).get();
  if (!driver) {
    db.prepare(`INSERT INTO drivers(id,full_name,status) VALUES('d1','Иванов Иван','active')`).run();
  }
  const driverId = driver?.id || 'd1';
  assert.equal(addSafetyEvent(db, { kind: 'dtp', driverId, happenedOn: '2026-11-05' }, 'БДД').ok, false);
  const dtp = addSafetyEvent(db, { kind: 'dtp', driverId, happenedOn: '2026-11-05', description: 'наезд на препятствие' }, 'БДД');
  assert.ok(dtp.ok);
  assert.equal(closeSafetyEvent(db, dtp.id, '', 'БДД').ok, false);
  assert.ok(closeSafetyEvent(db, dtp.id, 'внеплановый инструктаж', 'БДД').ok);
  assert.equal(addSafetyEvent(db, { kind: 'admission', driverId, happenedOn: '2026-11-01' }, 'БДД').ok, false); // срок обязателен
  assert.ok(addSafetyEvent(db, { kind: 'admission', driverId, happenedOn: '2026-11-01', validUntil: '2026-11-20' }, 'БДД').ok);
  const board = safetyBoard(db, { from: '2026-11-01', to: '2026-11-30', warnDays: 30, nowMs: Date.parse('2026-11-07T10:00:00Z') });
  assert.equal(board.summary.dtp, 1);
  assert.equal(board.terms[0].termStatus, 'soon');
  assert.ok(!board.withoutAdmission.some(row => row.id === driverId));
});

test('роли: БДД — журнал без денег; руководитель логистики — «Отчёты отдела»', t => {
  const db = freshDb(t);
  const make = (n, set) => {
    const positionId = db.prepare('SELECT id FROM org_positions WHERE n=?').get(n).id;
    const r = createStaffUser(db, { fullName: `Т ${n}`, positionId, username: `t${n}`, password: 'Very-strong-password-2026' }, { hashPassword });
    assert.ok(assignRoleSets(db, r.id, [set]).ok);
    return accessOf(db, db.prepare('SELECT * FROM users WHERE id=?').get(r.id));
  };
  const bdd = make(2, 'staff_bdd');
  assert.ok(bdd.views.includes('safety'));
  assert.equal(bdd.money, 'none');
  assert.ok(make(5, 'log_head').views.includes('logreports'));
  assert.ok(make(11, 'drv_acc').views.includes('docs'));
});
