// Текучесть водителей: разметка дат, формула, порог короткого стажа, права (07.11.2026).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../src/db.mjs';
import { hasPermission } from '../src/permissions.mjs';
import { driverTurnover, median, migrateTurnover, shortTenureThreshold, syncTurnoverDates,
  turnoverApi, turnoverRights, seedTurnoverSettings, TURNOVER_START } from '../src/turnover.mjs';
import { turnoverSection } from '../public/assets/turnover.js';

function freshDb(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pegas-turnover-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = openDatabase(path.join(directory, 'planner.db'), {
    username: 'root-admin', password: 'Temporary-password-2026', fullName: 'Администратор'
  });
  t.after(() => db.close());
  // Сид водителей из карточек ТС мешает точным числам — тест строит своих.
  db.exec(`PRAGMA foreign_keys=OFF; DELETE FROM drivers; DELETE FROM audit_log WHERE entity='driver'; PRAGMA foreign_keys=ON;`);
  return db;
}
const addDriver = (db, { name, created, status = 'active', updated = created, note = '' }) => {
  const id = randomUUID();
  db.prepare(`INSERT INTO drivers(id,full_name,status,note,created_at,updated_at) VALUES(?,?,?,?,?,?)`)
    .run(id, name, status, note, `${created} 09:00:00`, `${updated} 09:00:00`);
  return id;
};
const addAudit = (db, id, action, day, details = {}) => db.prepare(`INSERT INTO audit_log(id,action,entity,entity_id,details_json,created_at)
  VALUES(?,?,?,?,?,?)`).run(randomUUID(), action, 'driver', id, JSON.stringify(details), `${day} 10:00:00`);
const setTurnover = (db, value) => db.prepare(`INSERT OR REPLACE INTO settings(key,value_json) VALUES('turnover',?)`)
  .run(JSON.stringify(value));

// Сентябрь: 3 «в штате до учёта», двое принятых, двое уволенных, дубль и пустая запись.
function september(db) {
  const ids = {};
  ids.a = addDriver(db, { name: 'Агапов Иван Петрович', created: '2026-09-01' });
  ids.b = addDriver(db, { name: 'Борисов Олег', created: '2026-09-01', status: 'fired', updated: '2026-09-12' });
  addAudit(db, ids.b, 'delete', '2026-09-10', { soft: true, reason: 'По собственному желанию' });
  ids.c = addDriver(db, { name: 'Цветков Пётр', created: '2026-09-01', status: 'fired' });
  addAudit(db, ids.c, 'delete', '2026-09-15', { soft: true, reason: 'Иное — дубль' });
  ids.d = addDriver(db, { name: 'Демин Сергей', created: '2026-09-11', status: 'fired' });
  addAudit(db, ids.d, 'create', '2026-09-11', { fullName: 'Демин Сергей' });
  addAudit(db, ids.d, 'delete', '2026-09-20', { soft: true, reason: 'По собственному желанию' });
  ids.e = addDriver(db, { name: 'Ершов Глеб', created: '2026-09-21' });
  ids.f = addDriver(db, { name: 'Без водителя', created: '2026-09-05', status: 'fired', updated: '2026-09-06' });
  return ids;
}

test('миграция добавляет даты и идемпотентна с меткой в app_meta', t => {
  const db = freshDb(t);
  const ids = september(db);
  // openDatabase уже прогнал миграцию на пустом штате — метку снимаем,
  // чтобы проверить первый прогон на данных теста.
  db.prepare(`DELETE FROM app_meta WHERE key='driver_turnover_dates_v1'`).run();
  const first = migrateTurnover(db);
  assert.equal(first.baseline, 3);
  assert.deepEqual(first.fired, { real: 2, duplicate: 1, phantom: 1 });
  const meta = JSON.parse(db.prepare(`SELECT value FROM app_meta WHERE key='driver_turnover_dates_v1'`).get().value);
  assert.equal(meta.accountingFrom, '2026-09-01');
  assert.equal(migrateTurnover(db).changed, 0); // повтор ничего не меняет
  const d = db.prepare('SELECT * FROM drivers WHERE id=?').get(ids.d);
  assert.equal(d.hired_on, '2026-09-11');
  assert.equal(d.hired_source, 'audit');
  assert.equal(d.fired_on, '2026-09-20');
  assert.equal(d.fired_kind, 'real');
  const e = db.prepare('SELECT * FROM drivers WHERE id=?').get(ids.e);
  assert.equal(e.hired_source, 'created');
  const a = db.prepare('SELECT * FROM drivers WHERE id=?').get(ids.a);
  assert.equal(a.hired_on, null);
  assert.equal(a.hired_source, 'baseline');
  assert.equal(db.prepare('SELECT fired_kind k FROM drivers WHERE id=?').get(ids.f).k, 'phantom');
});

test('формула: уволено / среднесписочная × 100, дубли и пустые записи не считаются', t => {
  const db = freshDb(t);
  september(db);
  migrateTurnover(db);
  const r = driverTurnover(db, { from: '2026-09-01', to: '2026-09-30', today: '2026-10-01' });
  // А 30 дн + Б 10 (по 10.09 включительно) + Д 10 (11–20) + Е 10 (21–30) = 60 / 30 = 2
  assert.equal(r.headcountAvg, 2);
  assert.equal(r.hired, 2); // Д и Е; «в штате до учёта» — не приём
  assert.equal(r.fired, 2); // Б и Д; дубль Ц и «Без водителя» исключены
  assert.equal(r.turnoverPct, 100);
  assert.equal(r.excludedFired.length, 2);
  assert.deepEqual(r.excludedFired.map(x => x.kind).sort(), ['duplicate', 'phantom']);
  assert.equal(r.recentFired[0].name, 'Демин Сергей');
  assert.equal(r.recentFired[0].tenureDays, 9);
  assert.equal(r.recentFired[0].tenureKnown, true);
  const b = r.recentFired.find(x => x.name === 'Борисов Олег');
  assert.equal(b.tenureKnown, false); // стаж до учёта неизвестен — только нижняя граница
  assert.equal(b.tenureDays, 9);
  assert.equal(r.byMonth.length, 1);
  assert.equal(r.byMonth[0].turnoverPct, 100);
  // Период до начала учёта обрезается и это видно.
  const wide = driverTurnover(db, { from: '2026-08-01', to: '2026-09-30', today: '2026-10-01' });
  assert.equal(wide.coverageFrom, '2026-09-01');
  assert.equal(wide.headcountAvg, 2);
  assert.match(wide.note, /01\.09\.2026/);
  const before = driverTurnover(db, { from: '2026-07-01', to: '2026-07-31', today: '2026-10-01' });
  assert.equal(before.turnoverPct, null);
  assert.throws(() => driverTurnover(db, { from: '2026-09-30', to: '2026-09-01' }), /Период/);
});

test('по месяцам и восстановление снимает увольнение', t => {
  const db = freshDb(t);
  const ids = september(db);
  migrateTurnover(db);
  const r = driverTurnover(db, { from: '2026-09-01', to: '2026-10-31', today: '2026-11-01' });
  assert.deepEqual(r.byMonth.map(m => m.month), ['2026-09', '2026-10']);
  assert.equal(r.byMonth[1].headcountAvg, 2); // А и Е весь октябрь
  assert.equal(r.byMonth[1].fired, 0);
  db.prepare(`UPDATE drivers SET status='active' WHERE id=?`).run(ids.b);
  addAudit(db, ids.b, 'restore', '2026-09-25', {});
  syncTurnoverDates(db);
  const row = db.prepare('SELECT fired_on, fired_kind FROM drivers WHERE id=?').get(ids.b);
  assert.equal(row.fired_on, null);
  assert.equal(row.fired_kind, null);
  assert.equal(driverTurnover(db, { from: '2026-09-01', to: '2026-09-30', today: '2026-10-01' }).fired, 1);
});

test('тёзка, оставшийся работать, и слияние дублей — не увольнение; дата не раньше последней явки', t => {
  const db = freshDb(t);
  addDriver(db, { name: 'Старт Старт', created: '2026-09-01' });
  const dup = addDriver(db, { name: 'Истратов Сергей', created: '2026-09-02', status: 'fired' });
  addAudit(db, dup, 'delete', '2026-09-08', { soft: true });
  addDriver(db, { name: 'Истратов  Сергей Фёдорович', created: '2026-09-03' });
  const merged = addDriver(db, { name: 'Королёв Иван', created: '2026-09-04', status: 'fired' });
  addAudit(db, merged, 'merge-double', '2026-09-09', { into: 'x' });
  const late = addDriver(db, { name: 'Поздний Отметчик', created: '2026-09-04', status: 'fired', updated: '2026-09-05' });
  db.prepare(`INSERT INTO driver_attendance(id,driver_id,day,status) VALUES(?,?,?,?)`).run(randomUUID(), late, '2026-09-07', 'present');
  migrateTurnover(db);
  const kind = id => db.prepare('SELECT fired_kind k, fired_on d, fired_source s FROM drivers WHERE id=?').get(id);
  assert.equal(kind(dup).k, 'duplicate');
  assert.equal(kind(merged).k, 'duplicate');
  assert.equal(kind(late).k, 'real'); // работал (явка), причины нет — увольнение
  assert.equal(kind(late).d, '2026-09-07');
  assert.equal(kind(late).s, 'attendance');
});

test('порог короткого стажа: Настройки (ноль — осознанно) → медиана → неизвестен', () => {
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(shortTenureThreshold([1, 2], {}).source, 'none');
  assert.equal(shortTenureThreshold([1, 2], {}).days, null);
  const learned = shortTenureThreshold([10, 20, 30, 40, 50], {}, 365);
  assert.equal(learned.source, 'learned');
  assert.equal(learned.days, 30);
  assert.equal(shortTenureThreshold([10, 20], { turnover: { minSamples: 2 } }, 365).days, 15);
  assert.equal(shortTenureThreshold([10, 20, 30, 40, 50], {}, 25).days, 25); // кламп длиной истории
  assert.equal(shortTenureThreshold([10, 20, 30, 40, 50], {}, 25).clamped, true);
  const zero = shortTenureThreshold([10, 20, 30, 40, 50], { turnover: { shortTenureDays: 0 } });
  assert.equal(zero.source, 'settings');
  assert.equal(zero.days, 0);
});

test('короткий стаж в отчёте: по Настройке и цель текучести', t => {
  const db = freshDb(t);
  september(db);
  setTurnover(db, { shortTenureDays: 30, targetPct: 5 });
  migrateTurnover(db);
  const r = driverTurnover(db, { from: '2026-09-01', to: '2026-09-30', today: '2026-10-01' });
  assert.equal(r.threshold.source, 'settings');
  assert.deepEqual(r.shortTenure.map(x => x.name), ['Демин Сергей']); // Борисов — стаж неизвестен
  assert.equal(r.shortTenureShare, 50);
  assert.equal(r.targetPct, 5);
  setTurnover(db, { accountingFrom: '2026-09-15' }); // руководитель сдвинул начало учёта
  syncTurnoverDates(db);
  const shifted = driverTurnover(db, { from: '2026-09-01', to: '2026-09-30', today: '2026-10-01' });
  assert.equal(shifted.coverageFrom, '2026-09-15');
  assert.equal(shifted.hired, 1); // Демин (11.09) теперь «в штате до учёта», принят только Ершов
  assert.equal(shifted.threshold.source, 'none');
});

test('права: наборы ролей (resource/field у drv) и старая модель', () => {
  const user = { id: 'u', role: 'manager', active: 1 };
  const legacyNo = { id: 'x', role: 'driver_viewer' };
  assert.equal(turnoverRights({ user, access: { legacy: true }, hasPermission }).read, true);
  assert.equal(turnoverRights({ user: null, access: null, hasPermission }).read, false);
  const yes = { legacy: false, views: ['field'], scope: { all: false, depts: ['drv'] } };
  const otherDept = { legacy: false, views: ['field'], scope: { all: false, depts: ['log'] } };
  const noView = { legacy: false, views: ['sales'], scope: { all: true, depts: [] } };
  const all = { legacy: false, views: ['resource'], scope: { all: true, depts: [] } };
  assert.equal(turnoverRights({ user, access: yes, hasPermission }).read, true);
  assert.equal(turnoverRights({ user, access: otherDept, hasPermission }).read, false);
  assert.equal(turnoverRights({ user, access: noView, hasPermission }).read, false);
  assert.equal(turnoverRights({ user, access: all, hasPermission }).read, true);
  assert.equal(turnoverRights({ user: legacyNo, access: { legacy: true }, hasPermission: () => false }).read, false);
});

function ctxFor(db, { method = 'GET', target = '/api/turnover', access = { legacy: true }, body = {}, user = { id: 'u', role: 'admin', active: 1 } } = {}) {
  const url = new URL(`http://x${target}`);
  const out = {};
  return { out, ctx: { db, request: { method, headers: {}, socket: {} }, response: {}, url, pathname: url.pathname, user, access,
    json: (_r, status, payload) => Object.assign(out, { status, payload }),
    errorJson: (_r, status, message) => Object.assign(out, { status, payload: { error: message } }),
    readJson: async () => body,
    audit: (_db, _u, action) => { out.audited = action; },
    requestIp: () => '127.0.0.1', settingsObject: () => ({}), hasPermission } };
}

test('API: GET отдаёт отчёт, чужой путь пропускает, нет права — 403, ручная поправка', async t => {
  const db = freshDb(t);
  const ids = september(db);
  migrateTurnover(db);
  let { out, ctx } = ctxFor(db, { target: '/api/turnover?from=2026-09-01&to=2026-09-30' });
  assert.equal(await turnoverApi(ctx), true);
  assert.equal(out.status, 200);
  assert.equal(out.payload.turnoverPct, 100);
  assert.equal(out.payload.canWrite, true);
  ({ out, ctx } = ctxFor(db, { target: '/api/crm/summary' }));
  assert.equal(await turnoverApi(ctx), false);
  ({ out, ctx } = ctxFor(db, { access: { legacy: false, views: ['sales'], scope: { all: false, depts: ['log'] } } }));
  assert.equal(await turnoverApi(ctx), true);
  assert.equal(out.status, 403);
  ({ out, ctx } = ctxFor(db, { target: '/api/turnover?from=2026-09-30&to=2026-09-01' }));
  await turnoverApi(ctx);
  assert.equal(out.status, 422);
  // Дата приёма «в штате до учёта» — из кадров: стаж становится известным.
  ({ out, ctx } = ctxFor(db, { method: 'PATCH', target: `/api/turnover/drivers/${ids.b}`, body: { hiredOn: '2025-03-01' } }));
  await turnoverApi(ctx);
  assert.equal(out.status, 200);
  assert.equal(out.audited, 'turnover-fix');
  const b = db.prepare('SELECT hired_on, hired_source FROM drivers WHERE id=?').get(ids.b);
  assert.deepEqual({ ...b }, { hired_on: '2025-03-01', hired_source: 'manual' });
  const after = driverTurnover(db, { from: '2026-09-01', to: '2026-09-30', today: '2026-10-01' });
  assert.equal(after.recentFired.find(x => x.id === ids.b).tenureKnown, true);
  assert.equal(after.headcountAvg, 2); // до начала учёта период всё равно обрезан
  // Дубль, ошибочно размеченный, руководитель возвращает в увольнения.
  ({ out, ctx } = ctxFor(db, { method: 'PATCH', target: `/api/turnover/drivers/${ids.c}`, body: { kind: 'real' } }));
  await turnoverApi(ctx);
  assert.equal(out.status, 200);
  assert.equal(driverTurnover(db, { from: '2026-09-01', to: '2026-09-30', today: '2026-10-01' }).fired, 3);
  ({ out, ctx } = ctxFor(db, { method: 'PATCH', target: `/api/turnover/drivers/${ids.a}`, body: { firedOn: '2026-09-02' } }));
  await turnoverApi(ctx);
  assert.equal(out.status, 422); // работающего «увольнять» здесь нельзя
});

test('фронт-секция: показатели, месяцы, экранирование', t => {
  const db = freshDb(t);
  september(db);
  migrateTurnover(db);
  db.prepare(`UPDATE drivers SET full_name='<b>Ершов</b>' WHERE full_name='Ершов Глеб'`).run();
  const data = driverTurnover(db, { from: '2026-09-01', to: '2026-09-30', today: '2026-10-01' });
  data.recentFired[0].reason = '<script>';
  const html = turnoverSection(data);
  assert.match(html, /Текучесть водителей/);
  assert.match(html, /class="section dept-drv/);
  assert.match(html, /100<small>%/);
  assert.match(html, /сен 26/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /не считаются увольнением: 2/);
  assert.match(turnoverSection(null), /Нет данных/);
});

test('стартовые настройки текучести: пишутся один раз, заданное руководителем не трогают', t => {
  const db = freshDb(t);
  const saved = JSON.parse(db.prepare(`SELECT value_json FROM settings WHERE key='turnover'`).get().value_json);
  assert.deepEqual(saved, TURNOVER_START);
  db.prepare(`UPDATE settings SET value_json=? WHERE key='turnover'`).run(JSON.stringify({ targetPct: 0 }));
  seedTurnoverSettings(db); // метка стоит — повтор ничего не меняет
  assert.deepEqual(JSON.parse(db.prepare(`SELECT value_json FROM settings WHERE key='turnover'`).get().value_json), { targetPct: 0 });
  db.prepare(`DELETE FROM app_meta WHERE key='turnover_settings_v1'`).run();
  seedTurnoverSettings(db); // ноль руководителя — осознанное значение
  assert.equal(JSON.parse(db.prepare(`SELECT value_json FROM settings WHERE key='turnover'`).get().value_json).targetPct, 0);
});
