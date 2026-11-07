// «Карточка ТС» — нормы ТО вручную на машину, ТО по пробегу, сроки документов (07.11.2026).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../src/db.mjs';
import {
  migrateVehicleCards, toStatusOf, toStatusAll, docsDueAll, vehicleCard, saveVehicleCard,
  odometerAtRelease, ownDailyKm, vehicleCardRights, vehicleCardApi, planHorizonOf, docsWarnOf, houStatusOf, HOU_MIN_SAMPLES
} from '../src/vehicle-card.mjs';

function freshDb(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pegas-vcard-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = openDatabase(path.join(directory, 'planner.db'), {
    username: 'root-admin', password: 'Temporary-password-2026', fullName: 'Администратор'
  });
  t.after(() => db.close());
  migrateVehicleCards(db);
  return db;
}

const NOW = Date.parse('2026-11-07T09:00:00Z'); // 12:00 МСК, день МСК 2026-11-07
const dayOf = n => new Date(Date.parse('2026-11-07T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);

function odo(db, vehicleId, offsetDay, km) {
  db.prepare(`INSERT OR REPLACE INTO vehicle_odometers(vehicle_id,day,odo_km) VALUES(?,?,?)`).run(vehicleId, dayOf(offsetDay), km);
}
function releasedTo(db, vehicleId, arrivedAt, releasedAt, purpose = 'ТО') {
  db.prepare(`INSERT INTO repair_orders(id,vehicle_id,status,purpose,arrived_at,released_at)
    VALUES(?,?,'released',?,?,?)`).run(randomUUID(), vehicleId, purpose, arrivedAt, releasedAt);
}
const vehicleOf = db => db.prepare(`SELECT id, plate FROM vehicles LIMIT 1`).get();
// Ровный пробег: километров в сутки, с дня from по день to (смещения от сегодня).
function steadyRun(db, vehicleId, from, to, perDay, startKm = 100000) {
  for (let d = from; d <= to; d += 1) odo(db, vehicleId, d, startKm + (d - from) * perDay);
}

test('интервал не задан — no_norm, ничего не выдумываем', t => {
  const db = freshDb(t);
  const v = vehicleOf(db);
  steadyRun(db, v.id, -30, 0, 500);
  releasedTo(db, v.id, `${dayOf(-10)}T05:00:00Z`, `${dayOf(-10)}T12:00:00Z`);
  const s = toStatusOf(db, v.id, null, { nowMs: NOW, horizonDays: 3 });
  assert.equal(s.status, 'no_norm');
  assert.equal(s.leftKm, null);
  const all = toStatusAll(db, { nowMs: NOW, horizonDays: 3 });
  assert.ok(all.every(item => item.status === 'no_norm'));
});

test('пробег с ТО — по журналу одометров; нет ТО/одометров — no_data', t => {
  const db = freshDb(t);
  const v = vehicleOf(db);
  assert.ok(saveVehicleCard(db, v.id, { to_interval_km: '60000' }, 'Механик').ok);
  const card = () => db.prepare('SELECT * FROM vehicle_cards WHERE vehicle_id=?').get(v.id);
  assert.equal(toStatusOf(db, v.id, card(), { nowMs: NOW }).status, 'no_data'); // ни ТО, ни одометров
  // Заезд 10-го числа назад, стояла до выпуска 8-го; снимок 8-го (00:00) — во время стоянки.
  odo(db, v.id, -12, 99000); odo(db, v.id, -8, 100000); odo(db, v.id, -7, 100300); odo(db, v.id, 0, 102500);
  releasedTo(db, v.id, `${dayOf(-10)}T06:00:00Z`, `${dayOf(-8)}T15:00:00Z`);
  const base = odometerAtRelease(db, v.id, `${dayOf(-8)}T15:00:00Z`, `${dayOf(-10)}T06:00:00Z`);
  assert.deepEqual(base, { day: dayOf(-8), odo_km: 100000, side: 'before' });
  const s = toStatusOf(db, v.id, card(), { nowMs: NOW, horizonDays: 3 });
  assert.equal(s.sinceKm, 2500);
  assert.equal(s.leftKm, 57500);
  assert.equal(s.status, 'ok');
  // Старый снимок до долгого пропуска журнала — берётся ближайший после выпуска.
  const far = odometerAtRelease(db, v.id, `${dayOf(-2)}T20:00:00Z`, `${dayOf(-3)}T06:00:00Z`);
  assert.deepEqual(far, { day: dayOf(0), odo_km: 102500, side: 'after' }); // до: снимок за 5 сут, после: через 1 ч
  // Одометр «назад» (замена датчика) — честное no_data.
  odo(db, v.id, 0, 90000);
  assert.equal(toStatusOf(db, v.id, card(), { nowMs: NOW }).status, 'no_data');
});

test('собственный пробег — медиана положительных суточных разностей за 28 суток', t => {
  const db = freshDb(t);
  const v = vehicleOf(db);
  odo(db, v.id, -40, 0); // вне окна
  odo(db, v.id, -5, 1000); odo(db, v.id, -4, 1400); odo(db, v.id, -3, 1400); // стоянка — не считается
  odo(db, v.id, -1, 2400); odo(db, v.id, 0, 2900); // пропуск: 1000 за 2 сут = 500/сут
  assert.equal(ownDailyKm(db, v.id, dayOf(0)), 500); // [400, 500, 500] → 500
});

test('«скоро» — остаток меньше собственного пробега за горизонт плана; overdue — перепробег', t => {
  const db = freshDb(t);
  const v = vehicleOf(db);
  saveVehicleCard(db, v.id, { to_interval_km: 20000 }, 'Механик');
  const card = () => db.prepare('SELECT * FROM vehicle_cards WHERE vehicle_id=?').get(v.id);
  releasedTo(db, v.id, `${dayOf(-29)}T05:00:00Z`, `${dayOf(-29)}T12:00:00Z`);
  steadyRun(db, v.id, -29, 0, 650, 100000); // 29 сут × 650 = 18 850, остаток 1 150
  let s = toStatusOf(db, v.id, card(), { nowMs: NOW, horizonDays: 3 }); // 650×3 = 1 950 > 1 150
  assert.equal(s.sinceKm, 18850);
  assert.equal(s.leftKm, 1150);
  assert.equal(Math.round(s.avgDayKm), 650);
  assert.equal(s.status, 'soon');
  assert.equal(toStatusOf(db, v.id, card(), { nowMs: NOW, horizonDays: 1 }).status, 'ok'); // 650 < 1 150
  assert.equal(toStatusOf(db, v.id, card(), { nowMs: NOW, horizonDays: 0 }).status, 'ok'); // ноль — осознанно
  saveVehicleCard(db, v.id, { to_interval_km: 18000 }, 'Механик');
  s = toStatusOf(db, v.id, card(), { nowMs: NOW, horizonDays: 3 });
  assert.equal(s.status, 'overdue');
  assert.equal(s.leftKm, -850);
  // ТО по парку: просроченная машина — первой.
  const all = toStatusAll(db, { nowMs: NOW, horizonDays: 3 });
  assert.equal(all[0].vehicleId, v.id);
  assert.equal(all[0].status, 'overdue');
  // Последним ТО считается только purpose='ТО' и выпуск.
  releasedTo(db, v.id, `${dayOf(-2)}T05:00:00Z`, `${dayOf(-2)}T12:00:00Z`, 'шины');
  assert.equal(toStatusOf(db, v.id, card(), { nowMs: NOW }).lastToAt, `${dayOf(-29)}T12:00:00Z`);
});

test('горизонт и порог документов — из настроек, пусто → утверждённые значения', () => {
  assert.equal(planHorizonOf({}), 3);
  assert.equal(planHorizonOf({ calculation: { planHorizonDays: 5 } }), 5);
  assert.equal(planHorizonOf({ calculation: { planHorizonDays: 0 } }), 0);
  assert.equal(docsWarnOf({ calculation: {} }), 30);
  assert.equal(docsWarnOf({ calculation: { docsWarnDays: 14 } }), 14);
});

test('документы: soon/expired по порогу, не внесён — unknown', t => {
  const db = freshDb(t);
  const v = vehicleOf(db);
  assert.ok(saveVehicleCard(db, v.id, { osago_until: dayOf(10), kasko_until: dayOf(-1), techinspect_until: dayOf(40) }, 'Ресурс').ok);
  let card = vehicleCard(db, v.id, { nowMs: NOW, warnDays: 30, horizonDays: 3 });
  const by = Object.fromEntries(card.docs.map(item => [item.doc, item]));
  assert.equal(by.osago.status, 'soon');
  assert.equal(by.osago.daysLeft, 10);
  assert.equal(by.kasko.status, 'expired');
  assert.equal(by.techinspect.status, 'ok');
  assert.equal(by.tacho.status, 'unknown');
  card = vehicleCard(db, v.id, { nowMs: NOW, warnDays: 5, horizonDays: 3 });
  assert.equal(card.docs.find(item => item.doc === 'osago').status, 'ok');
  const due = docsDueAll(db, { nowMs: NOW, warnDays: 30 });
  assert.deepEqual(due.map(item => [item.doc, item.status]), [['kasko', 'expired'], ['osago', 'soon']]);
  assert.equal(due[0].plate, v.plate);
  // Ошибки ввода — человеческим текстом, без записи.
  assert.equal(saveVehicleCard(db, v.id, { osago_until: '31.12.2026' }, 'Ресурс').status, 422);
  assert.equal(saveVehicleCard(db, v.id, { to_interval_km: '-5' }, 'Ресурс').status, 422);
  assert.equal(saveVehicleCard(db, 'нет-такой', { vin: 'X' }, 'Ресурс').status, 404);
  // Пустое — «не задано».
  saveVehicleCard(db, v.id, { osago_until: '' }, 'Ресурс');
  assert.equal(vehicleCard(db, v.id, { nowMs: NOW, warnDays: 30, horizonDays: 3 }).card.osago_until, null);
});

test('карточка: данные машины из планера, история; затрат нет', t => {
  const db = freshDb(t);
  const v = vehicleOf(db);
  releasedTo(db, v.id, `${dayOf(-3)}T05:00:00Z`, `${dayOf(-2)}T12:00:00Z`);
  const card = vehicleCard(db, v.id, { nowMs: NOW, warnDays: 30, horizonDays: 3 });
  assert.equal(card.vehicle.plate, v.plate);
  assert.equal(card.history.repairs.length, 1);
  assert.ok(Array.isArray(card.history.trips));
  assert.ok(!('expenses' in card.history));
  assert.equal(vehicleCard(db, 'нет-такой'), null);
});

const has = perms => (user, perm) => perms.includes(perm);
test('права: читают Ремзона/Ресурс/Выпуск/руководитель, правит только fleet:write', async t => {
  assert.deepEqual(vehicleCardRights({}, { views: [] }, has(['fleet:write'])), { read: true, write: true });
  assert.deepEqual(vehicleCardRights({}, { views: [] }, has(['release:write'])), { read: true, write: false });
  assert.deepEqual(vehicleCardRights({}, { views: [] }, has(['reports:read'])), { read: true, write: false });
  assert.deepEqual(vehicleCardRights({}, { views: ['remzona'] }, has([])), { read: true, write: false });
  assert.deepEqual(vehicleCardRights({}, { views: ['sales'] }, has(['planner:read'])), { read: false, write: false });

  const db = freshDb(t);
  const v = vehicleOf(db);
  const audits = [];
  const call = async (method, pathname, perms, body = {}, views = []) => {
    const out = {};
    const handled = await vehicleCardApi({
      db, request: { method }, response: {}, url: new URL(`http://x${pathname}`), pathname,
      user: { id: 'u1', full_name: 'Тест' }, access: { scope: { all: true }, money: 'none', views, legacy: false },
      json: (r, status, obj) => Object.assign(out, { status, obj }),
      errorJson: (r, status, msg) => Object.assign(out, { status, msg }),
      readJson: async () => body, audit: (...args) => audits.push(args), requestIp: () => '127.0.0.1',
      settingsObject: () => ({ calculation: {} }), hasPermission: has(perms)
    });
    return { handled, ...out };
  };
  assert.equal((await call('GET', '/api/other', ['fleet:write'])).handled, false);
  assert.equal((await call('GET', `/api/vehicle-card/${v.id}`, [])).status, 403);
  const read = await call('GET', `/api/vehicle-card/${v.id}`, ['reports:read']);
  assert.equal(read.status, 200);
  assert.equal(read.obj.canWrite, false);
  assert.equal((await call('PATCH', `/api/vehicle-card/${v.id}`, ['release:write'], { vin: 'X' })).status, 403);
  const saved = await call('PATCH', `/api/vehicle-card/${v.id}`, ['fleet:write'], { vin: 'XTC123', to_interval_km: 50000 });
  assert.equal(saved.status, 200);
  assert.equal(saved.obj.card.vin, 'XTC123');
  assert.equal(saved.obj.updatedBy, 'Тест');
  assert.equal(audits.length, 1);
  assert.equal(audits[0][2], 'vehicle_card_update');
  assert.equal(audits[0][6], '127.0.0.1');
  const list = await call('GET', '/api/vehicle-card/to-status', [], {}, ['resource']);
  assert.equal(list.status, 200);
  assert.equal(list.obj.horizonDays, 3);
  assert.ok(list.obj.items.some(item => item.vehicleId === v.id && item.status === 'no_data'));
});

test('ТО ХОУ: моточасы из закрытых ПЛ, скорость копится до 5 листов', t => {
  const db = freshDb(t);
  const v = vehicleOf(db);
  const card = { hou_interval_mh: 1000 };
  releasedTo(db, v.id, `${dayOf(-20)}T05:00:00Z`, `${dayOf(-20)}T12:00:00Z`);
  let number = 9000;
  const waybill = (startOff, endOff, mhStart, mhEnd, status = 'closed') => db.prepare(`INSERT INTO waybills(id,year,number,vehicle_id,
      starts_at,ends_at,status,mh_start,mh_end) VALUES(?,?,?,?,?,?,?,?,?)`).run(randomUUID(), 2026, number++, v.id,
    `${dayOf(startOff)}T06:00:00Z`, `${dayOf(endOff)}T06:00:00Z`, status, mhStart, mhEnd);
  assert.equal(houStatusOf(db, v.id, {}, { nowMs: NOW }).status, 'no_norm');
  assert.equal(houStatusOf(db, v.id, card, { nowMs: NOW }).status, 'no_data');
  waybill(-19, -17, 5000, 5040);
  let s = houStatusOf(db, v.id, card, { nowMs: NOW, horizonDays: 3 });
  assert.equal(s.sinceMh, 40);
  assert.equal(s.avgDayMh, null); // 1 из 5 — скорость копится
  assert.match(s.reason, /копится/);
  for (let i = 0; i < HOU_MIN_SAMPLES; i += 1) waybill(-16 + i * 3, -14 + i * 3, 5040 + i * 40, 5080 + i * 40);
  waybill(-1, 0, 5900, 5960, 'issued'); // открытый лист не считается
  s = houStatusOf(db, v.id, card, { nowMs: NOW, horizonDays: 3 });
  assert.equal(s.avgDayMh, 20);
  assert.equal(s.sinceMh, 240);
  assert.equal(s.status, 'ok');
  s = houStatusOf(db, v.id, { hou_interval_mh: 280 }, { nowMs: NOW, horizonDays: 3 });
  assert.equal(s.status, 'soon'); // осталось 40 < 20 × 3
  assert.equal(houStatusOf(db, v.id, { hou_interval_mh: 200 }, { nowMs: NOW }).status, 'overdue');
});
