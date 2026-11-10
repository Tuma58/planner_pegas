// 📐 Тех. задание (10.11.2026): механика HELP DESK для руководителей —
// вид заявки kind, круг доступа, ответ автору своим заголовком.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/db.mjs';
import { accessOf, assignRoleSets } from '../src/access.mjs';
import { helpdeskStatusMessage, tzAccess } from '../src/helpdesk.mjs';
import { createStaffUser } from '../src/staff.mjs';
import { hashPassword } from '../src/security.mjs';

function freshDb(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pegas-tz-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = openDatabase(path.join(directory, 'planner.db'), {
    username: 'root-admin', password: 'Temporary-password-2026', fullName: 'Администратор'
  });
  t.after(() => db.close());
  return db;
}

test('ТЗ: заявки получили вид и отдел, прежние остаются HELP DESK', t => {
  const db = freshDb(t);
  const cols = db.prepare(`PRAGMA table_info(helpdesk_tickets)`).all().map(col => col.name);
  assert.ok(cols.includes('kind') && cols.includes('dept'));
  db.prepare(`INSERT INTO helpdesk_tickets(id,author_name,problem) VALUES('a','Х','что-то не так давно')`).run();
  assert.equal(db.prepare(`SELECT kind FROM helpdesk_tickets WHERE id='a'`).get().kind, 'helpdesk');
});

test('ТЗ: подают и видят руководители (поле), исполнители — нет; без наборов — manager/admin', t => {
  const db = freshDb(t);
  const person = set => {
    const r = createStaffUser(db, { fullName: `Тест ${set}` }, { hashPassword });
    assignRoleSets(db, r.id, [set]);
    return accessOf(db, db.prepare('SELECT * FROM users WHERE id=?').get(r.id));
  };
  for (const set of ['dir_head', 'log_head', 'drv_head', 'toir_head']) assert.ok(tzAccess(person(set)), set);
  for (const set of ['log_assign', 'log_ctrl', 'drv_column', 'toir_mech', 'guard']) assert.ok(!tzAccess(person(set)), set);
  assert.ok(tzAccess({ legacy: true }, ['manager']));
  assert.ok(!tzAccess({ legacy: true }, ['logist']));
});

test('ТЗ: ответ автору — с пометкой ТЗ, HELP DESK — прежний', () => {
  const base = { problem: 'Добавить в АРМ план ТО на неделю' };
  assert.match(helpdeskStatusMessage({ ...base, kind: 'tz' }, 'work'), /^📐 Ваше ТЗ «.+» — взято в работу/);
  assert.match(helpdeskStatusMessage({ ...base, kind: 'helpdesk' }, 'work'), /^🛟 Ваша заявка «.+» — взята в работу/);
});
