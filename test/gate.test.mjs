// Журнал КПП стоянки базы — рабочее место охранника-парковщика (07.11.2026).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/db.mjs';
import { gateCancel, gateEdit, gateExitAt, gateHints, gateRegister, gateReport, normPlate } from '../src/gate.mjs';
import { accessOf, assignRoleSets } from '../src/access.mjs';
import { createStaffUser } from '../src/staff.mjs';
import { hashPassword } from '../src/security.mjs';
import { effectivePermissions } from '../src/permissions.mjs';

function freshDb(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pegas-gate-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = openDatabase(path.join(directory, 'planner.db'), {
    username: 'root-admin', password: 'Temporary-password-2026', fullName: 'Администратор'
  });
  t.after(() => db.close());
  return db;
}

test('номер к единому виду: латиница → кириллица, Ё → Е, без пробелов', () => {
  assert.equal(normPlate('a 123 bc 58'), 'А123ВС58');
  assert.equal(normPlate('р271ск58'), 'Р271СК58');
});

test('одна кнопка: въезд, потом выезд; тягач узнаётся из планера', t => {
  const db = freshDb(t);
  const truck = db.prepare(`SELECT id, plate FROM vehicles WHERE status='work' LIMIT 1`).get();
  const entry = gateRegister(db, 'Охранник', { plate: truck.plate.toUpperCase() }, '2026-11-07T05:00:00.000Z');
  assert.equal(entry.kind, 'in');
  assert.equal(entry.record.type, 'truck');
  assert.equal(entry.record.vehicle_id, truck.id);
  const exit = gateRegister(db, 'Охранник', { plate: truck.plate }, '2026-11-07T09:30:00.000Z');
  assert.equal(exit.kind, 'out');
  // Неизвестный номер — нужен тип; личный — запоминается в справочнике.
  assert.equal(gateRegister(db, 'Охранник', { plate: 'Х777ХХ58' }).error, 'NEED_TYPE');
  assert.equal(gateRegister(db, 'Охранник', { plate: 'Х777ХХ58', type: 'personal', person: 'Иванов', addDir: true }, '2026-11-07T11:00:00.000Z').kind, 'in');
  assert.equal(db.prepare(`SELECT type FROM gate_dir WHERE plate='Х777ХХ58'`).get().type, 'personal');
  const report = gateReport(db, '2026-11-07T00:00:00.000Z', '2026-11-08T00:00:00.000Z', '2026-11-07T12:00:00.000Z');
  assert.equal(report.visits.length, 2);
  assert.equal(report.visits.find(visit => visit.type === 'truck').minutes, 270);
});

test('задним числом и правки — только с проверкой и отметкой; аннулирование с причиной', t => {
  const db = freshDb(t);
  const now = Date.parse('2026-11-07T12:00:00.000Z');
  const r = gateRegister(db, 'Петров', { plate: 'А001АА58', type: 'other' }, '2026-11-07T08:00:00.000Z');
  assert.equal(gateExitAt(db, r.record.id, 'Петров', '2026-11-07T07:00:00.000Z', now).ok, false); // раньше въезда
  assert.equal(gateExitAt(db, r.record.id, 'Петров', '2026-11-07T13:00:00.000Z', now).ok, false); // в будущем
  assert.ok(gateExitAt(db, r.record.id, 'Петров', '2026-11-07T10:00:00.000Z', now).ok);
  assert.ok(gateEdit(db, r.record.id, 'Сидоров', { note: 'грузчик' }, now).ok);
  const row = db.prepare('SELECT * FROM gate_log WHERE id=?').get(r.record.id);
  assert.match(row.edits, /задним числом.*исправил Сидоров/);
  assert.equal(gateCancel(db, r.record.id, 'Сидоров', '').ok, false);
  assert.ok(gateCancel(db, r.record.id, 'Сидоров', 'ошибочная отметка').ok);
  assert.equal(db.prepare('SELECT status FROM gate_log WHERE id=?').get(r.record.id).status, 'cancelled');
});

test('выезд тягача — подсказка диспетчеру, факт рейса НЕ ставится', t => {
  const db = freshDb(t);
  const truck = db.prepare(`SELECT id, plate FROM vehicles WHERE status='work' LIMIT 1`).get();
  gateRegister(db, 'Охранник', { plate: truck.plate }, '2026-11-07T05:00:00.000Z');
  const out = gateRegister(db, 'Охранник', { plate: truck.plate }, '2026-11-07T07:00:00.000Z');
  const hints = gateHints(db, out, 'Охранник');
  assert.equal(hints[0].role, 'dispatcher');
  assert.match(hints[0].text, /Факт выезда не поставлен/);
  const back = gateRegister(db, 'Охранник', { plate: truck.plate }, '2026-11-07T20:00:00.000Z');
  assert.equal(gateHints(db, back, 'Охранник')[0].role, 'resource');
});

test('роль «Охранник-парковщик»: только КПП, без денег, вход по своей учётке', t => {
  const db = freshDb(t);
  const positionId = db.prepare('SELECT id FROM org_positions WHERE n=4').get().id;
  const r = createStaffUser(db, { fullName: 'Охранник Тест', positionId, username: 'guard1', password: 'Very-strong-password-2026' }, { hashPassword });
  assert.ok(assignRoleSets(db, r.id, ['guard']).ok);
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(r.id);
  assert.deepEqual(JSON.parse(user.roles), ['guard']);
  assert.deepEqual(effectivePermissions(user), ['gate:write']);
  const access = accessOf(db, user);
  assert.deepEqual(access.views, ['gate']);
  assert.equal(access.money, 'none');
});
