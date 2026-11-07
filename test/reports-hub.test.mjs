// «Система отчётов» (Слияние, 07.11): реестр отчётов и его фильтр по
// ролям-наборам — reportsFor из public/assets/reports-core.js (без DOM).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/db.mjs';
import { accessOf, roleSets } from '../src/access.mjs';
import { ROLE_PERMISSIONS } from '../src/permissions.mjs';
import { LEVELS, REPORTS, groupByLevel, mergeCandidates, reportsFor, reportsLocked } from '../public/assets/reports-core.js';

function freshDb(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pegas-reports-hub-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = openDatabase(path.join(directory, 'planner.db'), {
    username: 'root-admin', password: 'Temporary-password-2026', fullName: 'Администратор'
  });
  t.after(() => db.close());
  return db;
}

// can() как в браузере: права — объединение прав кодов набора.
const canOf = codes => permission => codes.some(code => (ROLE_PERMISSIONS[code] || []).includes(permission));
const accessFor = (db, setId) => accessOf(db, { role_sets: JSON.stringify([setId]), roles: '[]' });
const ids = list => list.map(report => report.id);

test('реестр цел: уникальные id, известные уровни, отделы, деньги, способ открыть', () => {
  const levelIds = LEVELS.map(level => level.id);
  assert.equal(new Set(ids(REPORTS)).size, REPORTS.length);
  for (const report of REPORTS) {
    assert.ok(levelIds.includes(report.level), report.id);
    assert.ok(['', 'staff', 'log', 'drv', 'toir'].includes(report.dept), report.id);
    assert.ok(['full', 'rates', 'none'].includes(report.money), report.id);
    assert.ok(report.source && report.title, report.id);
    const open = report.open || {};
    assert.equal([open.kind, open.view, open.dialog, open.feed].filter(Boolean).length, 1, report.id);
    if (report.duplicateOf) assert.ok(REPORTS.some(item => item.id === report.duplicateOf), report.id);
    // Все виды openReport идут через /api/reports — требуют requireReports.
    if (open.kind) assert.ok(report.need.includes('reports'), report.id);
  }
});

test('legacy без reports:read — пусто; legacy руководитель — всё, что дают права', () => {
  assert.deepEqual(reportsFor(null, () => false), []);
  const legacy = { legacy: true, scope: { all: true, depts: [] }, views: null, money: 'full' };
  assert.deepEqual(reportsFor(legacy, canOf(['logist'])), []);
  const manager = reportsFor(legacy, canOf(['manager']));
  assert.ok(manager.length > 20);
  assert.ok(ids(manager).includes('summary') && ids(manager).includes('drivers'));
  const admin = reportsFor(legacy, () => true);
  assert.equal(admin.length, REPORTS.length);
  assert.deepEqual(reportsLocked(legacy, () => true), []);
});

test('руководитель направления видит весь реестр', t => {
  const db = freshDb(t);
  const set = roleSets(db).find(item => item.id === 'dir_head');
  const access = accessFor(db, 'dir_head');
  const visible = reportsFor(access, canOf(set.codes));
  assert.equal(visible.length, REPORTS.length - REPORTS.filter(report =>
    report.open.view && !access.views.includes(report.open.view)).length);
  assert.ok(ids(visible).includes('reconcile'));
});

test('руководитель логистики: свой отдел и утверждённые «Отчёты отдела», без Штаба и Эксплуатации', t => {
  const db = freshDb(t);
  const set = roleSets(db).find(item => item.id === 'log_head');
  const access = accessFor(db, 'log_head');
  const visible = reportsFor(access, canOf(set.codes));
  const got = ids(visible);
  // Те же семь видов, что в прежнем экране «Отчёты отдела» (logreports).
  for (const kind of ['summary', 'clients', 'econ', 'client-fleet', 'rejected', 'rejected-orders', 'execution']) {
    assert.ok(got.includes(kind), kind);
  }
  for (const report of visible) {
    assert.ok([report.dept, ...(report.alsoDepts || [])].includes('log'), report.id);
  }
  for (const foreign of ['drivers', 'mileage', 'reconcile', 'staff', 'history']) assert.ok(!got.includes(foreign), foreign);
  // «Скорости» — отдел свой, но сервер требует reports:read: видно серым.
  assert.ok(ids(reportsLocked(access, canOf(set.codes)).map(item => item.report)).includes('speed'));
});

test('уровень денег режет: «ставки» не видят выручку, «без денег» — ставки', () => {
  const base = { legacy: false, scope: { all: false, depts: ['log'] }, views: ['reports'] };
  const can = () => true;
  const rates = reportsFor({ ...base, money: 'rates' }, can);
  assert.ok(rates.every(report => report.money !== 'full'));
  assert.ok(ids(rates).includes('demurrage'));
  const none = reportsFor({ ...base, money: 'none' }, can);
  assert.ok(none.every(report => report.money === 'none'));
  assert.ok(!ids(none).includes('demurrage'));
  // requireReports без reports:read пускает экран отчётов только при full.
  const noPerm = permission => permission !== 'reports:read';
  assert.ok(!ids(reportsFor({ ...base, money: 'rates' }, noPerm)).includes('rejected-orders'));
  assert.ok(ids(reportsFor({ ...base, money: 'full' }, noPerm)).includes('rejected-orders'));
});

test('отчёт-экран показывается, только если экран есть в наборе', () => {
  const access = { legacy: false, scope: { all: true, depts: [] }, views: ['kpi'], money: 'full' };
  const got = ids(reportsFor(access, () => true));
  assert.ok(got.includes('kpi'));
  assert.ok(!got.includes('ops') && !got.includes('dashboard') && !got.includes('cfo'));
});

test('руководители эксплуатации и ТОиР без денег: ничего с выручкой', t => {
  const db = freshDb(t);
  for (const setId of ['drv_head', 'toir_head']) {
    const set = roleSets(db).find(item => item.id === setId);
    const access = accessFor(db, setId);
    const visible = reportsFor(access, canOf(set.codes));
    assert.ok(visible.every(report => report.money === 'none'), setId);
    assert.ok(visible.every(report => [report.dept, ...(report.alsoDepts || [])].includes(set.scope)), setId);
  }
});

test('группировка по уровням и список кандидатов на слияние', () => {
  const groups = groupByLevel(REPORTS);
  assert.deepEqual(groups.map(group => group.id), LEVELS.map(level => level.id));
  const merges = mergeCandidates();
  assert.ok(merges.some(item => item.id === 'park-1c' && item.verdict === 'кандидат на удаление'));
  assert.ok(merges.some(item => item.id === 'econ' && item.verdict === 'кандидат на слияние'));
  assert.ok(merges.every(item => item.reason));
});
