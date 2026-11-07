// Цели и задачи направления СТ (проект «Слияние», блок 2, 07.11.2026).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/db.mjs';
import { archiveGoal, evalMetric, goalsData, saveGoal } from '../src/goals.mjs';
import { directionGoals } from '../public/assets/goals-core.js';

function freshDb(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pegas-goals-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = openDatabase(path.join(directory, 'planner.db'), {
    username: 'root-admin', password: 'Temporary-password-2026', fullName: 'Администратор'
  });
  t.after(() => db.close());
  return db;
}

test('реестр целей: пустота → канон среды, ноль осознан, использование — произведение', () => {
  const canon = directionGoals({});
  assert.equal(canon.use, 95.1);
  assert.equal(canon.revenueMln, 175);
  assert.equal(canon.kmDay, 500);
  assert.equal(canon.fotPct, null);
  const custom = directionGoals({ ktgTargetPct: 90, kvlTargetPct: '', kipTargetPct: 0, dailyKmTarget: 450 });
  assert.equal(custom.ktg, 90);
  assert.equal(custom.kvl, 99);
  assert.equal(custom.use, 0);
  assert.equal(custom.kmDay, 450);
});

test('цели и задачи загружаются из среды СТ один раз, по 4 задачи на отдел', t => {
  const db = freshDb(t);
  const ctx = { goals: directionGoals({}), park: { ktg: 97.5, kvl: 94, kip: 99, koef: 90.7, fleet: 127 } };
  const data = goalsData(db, ctx);
  for (const dept of ['toir', 'drv', 'log', 'staff']) {
    assert.equal(data.items.filter(item => item.kind === 'task' && item.dept === dept).length, 4, dept);
    assert.equal(data.items.filter(item => item.kind === 'dept' && item.dept === dept).length, 1, dept);
  }
  assert.equal(data.items.filter(item => item.kind === 'principle').length, 5);
  assert.equal(data.items.filter(item => item.kind === 'mission').length, 1);
  const total = Object.values(data.summary).reduce((sum, n) => sum + n, 0);
  assert.equal(total, 16);
  // Правка руководителя не затирается повторным открытием.
  const task = data.items.find(item => item.kind === 'task' && item.dept === 'toir');
  assert.ok(saveGoal(db, { id: task.id, title: 'Плановый ТО по пробегу', metricKey: 'ktg' }).ok);
  assert.equal(goalsData(db, ctx).items.find(item => item.id === task.id).title, 'Плановый ТО по пробегу');
  assert.equal(saveGoal(db, { id: task.id, title: 'x', metricKey: 'нет_такого' }).ok, false);
  const mission = data.items.find(item => item.kind === 'mission');
  assert.equal(archiveGoal(db, mission.id).ok, false);
  assert.ok(archiveGoal(db, task.id).ok);
});

test('светофор: в норме / близко / мимо против реестра, без цели — справочно', () => {
  const ctx = { goals: directionGoals({}), park: { ktg: 97.5, kvl: 94.5, kip: 80, koef: 75 }, fines: 3 };
  assert.equal(evalMetric('ktg', ctx).tone, 'ok');
  assert.equal(evalMetric('kvl', ctx).tone, 'near');
  assert.equal(evalMetric('kip', ctx).tone, 'miss');
  assert.equal(evalMetric('fines', ctx).tone, 'info');
  assert.equal(evalMetric('repair_days', ctx).tone, 'none');
  assert.equal(evalMetric('pending:ФОТ', ctx).pending, 'ФОТ');
  // План месяца — ступень: цель выручки берётся из него, стратегия — в подписи.
  const revenue = evalMetric('revenue_month', { ...ctx, snap: { netRevenue: 150e6 }, revenuePlanMln: 165 });
  assert.equal(revenue.target, 165);
  assert.match(revenue.note, /стратегия 175/);
});
