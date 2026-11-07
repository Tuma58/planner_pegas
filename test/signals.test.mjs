// Сквозной контроль «мерим бдительность» и KPI отделов (блок 4, 07.11.2026).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/db.mjs';
import { acceptSignal, detectSignals, raiseSignal, signalKpi, signalRights } from '../src/signals.mjs';
import { kpiBinding, kpiDept } from '../src/kpi.mjs';
import { JOINTS } from '../src/field.mjs';

function freshDb(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pegas-signals-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = openDatabase(path.join(directory, 'planner.db'), {
    username: 'root-admin', password: 'Temporary-password-2026', fullName: 'Администратор'
  });
  t.after(() => db.close());
  return db;
}

test('детектор открывает случай «из ремонта без водителя» и сам закрывает по факту', t => {
  const db = freshDb(t);
  const vehicle = db.prepare(`SELECT id, plate FROM vehicles WHERE status='work' LIMIT 1`).get();
  const now = Date.now();
  const iso = ms => new Date(now + ms).toISOString();
  db.prepare(`INSERT INTO repair_orders(id,vehicle_id,status,purpose,released_at) VALUES('r1',?,'released','ТО',?)`)
    .run(vehicle.id, iso(-5 * 3.6e6));
  db.prepare(`INSERT INTO vehicle_dispositions(id,vehicle_id,kind,starts_at,ends_at) VALUES('d1',?,'no_driver',?,?)`)
    .run(vehicle.id, iso(-4 * 3.6e6), iso(48 * 3.6e6));
  detectSignals(db);
  const open = db.prepare(`SELECT * FROM joint_signals WHERE joint_key='toir_drv' AND closed_at IS NULL`).all();
  assert.equal(open.length, 1);
  assert.equal(open[0].plate, vehicle.plate);
  detectSignals(db); // повторный тик дублей не плодит
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM joint_signals WHERE joint_key='toir_drv'`).get().n, 1);
  // Сигнал контролёра (ТОиР) → принятие владельцем (Эксплуатация).
  assert.equal(acceptSignal(db, open[0].id, 'Иванов').ok, false); // принять до сигнала нельзя
  assert.ok(raiseSignal(db, open[0].id, 'Главный механик', iso(60_000)).ok);
  assert.equal(raiseSignal(db, open[0].id, 'повтор').ok, false);
  assert.ok(acceptSignal(db, open[0].id, 'Руководитель эксплуатации').ok);
  // Водитель назначен — диспозиция снята — случай закрылся сам.
  db.prepare(`DELETE FROM vehicle_dispositions WHERE id='d1'`).run();
  detectSignals(db);
  const row = db.prepare(`SELECT * FROM joint_signals WHERE id=?`).get(open[0].id);
  assert.ok(row.closed_at);
  assert.equal(row.close_reason, 'водитель назначен');
  // KPI: условие висело 4 ч до того, как система его увидела, — отсчёт
  // бдительности от момента «увидено»; сигнал через минуту — вовремя.
  const kpi = signalKpi(db, 'toir_drv', iso(-864e5), iso(864e5), 2);
  assert.equal(kpi.cases, 1);
  assert.equal(kpi.onTimePct, 100);
  assert.ok(kpi.signalMedianH < 0.1);
});

test('права: сигнал подаёт отдел-контролёр, принимает отдел-владелец', () => {
  const joint = JOINTS.find(item => item.key === 'toir_drv');
  assert.deepEqual(signalRights({ scope: { depts: ['toir'] } }, joint), { canSignal: true, canAccept: false });
  assert.deepEqual(signalRights({ scope: { depts: ['drv'] } }, joint), { canSignal: false, canAccept: true });
  assert.deepEqual(signalRights({ scope: { depts: ['log'] } }, joint), { canSignal: false, canAccept: false });
});

test('KPI отдела: основной, второй, контроль с весом 75/25, привязка паспорта', () => {
  const item = kpiDept({ dept: 'toir', park: { ktg: 97 }, targets: { КТГ: 97 },
    snap: { utilization: { machineDays: { repair: 12 } } },
    signals: { toir_drv: { cases: 4, signaled: 4, onTimePct: 50, signalMedianH: 3, targetH: 2 } },
    ownPct: 75, cfoCenter: { perMd: 210, filled: 2, articles: [1, 2] },
    positions: [{ n: 14, title: 'Главный механик', passport: { kpi: [['Основной', '≥97%'], ['Второй', 'норматив'], ['Сквозной', '≥95%'], ['ППР', '100%']] } }] });
  assert.equal(item.main.score, 100);
  assert.equal(item.main.lostMd, 12);
  assert.equal(item.index, Math.round(100 * 0.75 + 50 * 0.25));
  assert.equal(item.second.value, 210);
  assert.deepEqual(item.positions[0].kpi.map(row => row.bind), ['main', 'second', 'control', 'manual']);
  assert.match(item.positions[0].kpi[2].live, /50%/);
  // Сигналы ещё не посчитаны — честно «ждёт», без нуля; посчитаны и
  // случаев нет — не «ждёт» (стык Логистика→ТОиР живёт от норм ТО).
  assert.equal(kpiDept({ dept: 'log', park: {}, targets: {} }).control.pending, true);
  assert.equal(kpiDept({ dept: 'log', park: {}, targets: {}, signals: {} }).control.pending, false);
  assert.equal(kpiBinding(7, 0), 'personal');
  assert.equal(kpiBinding(20, 0), 'manual');
});
