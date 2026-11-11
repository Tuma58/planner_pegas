// Контроль процессов (11.11.2026): реестр, статусы, живой норматив
// «хуже обычного» из собственной истории, переходы для уведомлений.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/db.mjs';
import { PROCESSES, SYSTEM_PROCESSES, processAlertText, processControl, processControlTick } from '../src/process-control.mjs';

function freshDb(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pegas-pc-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = openDatabase(path.join(directory, 'planner.db'), { username: 'root-admin', password: 'Temporary-password-2026', fullName: 'А' });
  t.after(() => db.close());
  return db;
}
const sys = n => ({ sys_access: [{ label: 'С ролью, но без входа', value: n }], sys_watch: [{ label: 'Сторожа с ошибками', value: 0 }], sys_speed: [{ label: 'Медленные запросы', value: 0 }] });
const settings = { processControl: { windowDays: 14, alertPercentile: 90, minDays: 5 } };

test('реестр: у каждого процесса конвейера есть владелец и проверки; на пустой базе расчёт не падает', t => {
  const db = freshDb(t);
  for (const proc of PROCESSES) { assert.ok(proc.owner && proc.checks.length && proc.stage, proc.key); }
  const data = processControl(db, { settings, system: sys(0) });
  assert.equal(data.processes.length, PROCESSES.length + SYSTEM_PROCESSES.length);
  assert.ok(data.processes.every(proc => ['ok', 'work', 'bad', 'none'].includes(proc.status)));
  assert.equal(data.processes.find(proc => proc.key === 'sys_access').status, 'ok');
});

test('живой норматив: пока истории мало — только факт; выше своего перцентиля — «хуже обычного»; переходы — в уведомление', t => {
  const db = freshDb(t);
  const day = 864e5; const base = Date.parse('2026-11-20T09:00:00Z');
  // 6 суток истории с очередью 2–3.
  for (let i = 6; i >= 1; i -= 1) processControlTick(db, { settings, system: sys(i % 2 ? 2 : 3), nowMs: base - i * day });
  const calm = processControlTick(db, { settings, system: sys(3), nowMs: base });
  const access = calm.data.processes.find(proc => proc.key === 'sys_access');
  assert.equal(access.baseline, 3);
  assert.equal(access.status, 'work');
  assert.equal(calm.worse.length, 0);
  // Очередь выросла выше обычного.
  const spike = processControlTick(db, { settings, system: sys(9), nowMs: base + 15 * 60_000 });
  assert.deepEqual(spike.worse.map(proc => proc.key), ['sys_access']);
  assert.match(processAlertText(spike), /Хуже обычного.*Доступ.*обычно до 3/);
  // Повторный тик — уже известно, не повторяем.
  assert.equal(processControlTick(db, { settings, system: sys(9), nowMs: base + 30 * 60_000 }).worse.length, 0);
  // Восстановление.
  const back = processControlTick(db, { settings, system: sys(1), nowMs: base + 45 * 60_000 });
  assert.deepEqual(back.better.map(proc => proc.key), ['sys_access']);
  // Суточный след хранит худший статус дня.
  assert.equal(db.prepare(`SELECT status, load FROM process_control_days WHERE key='sys_access' ORDER BY day DESC LIMIT 1`).get().status, 'bad');
});

test('красная проверка по своей норме делает процесс «хуже обычного» и без истории; пропавшие данные — «без контроля»', t => {
  const db = freshDb(t);
  const red = { ...sys(0), sys_watch: [{ label: 'Сторожа с ошибками', value: 1, tone: 'neg', note: 'runX: boom' }] };
  processControlTick(db, { settings, system: sys(0) });
  const tick = processControlTick(db, { settings, system: red });
  assert.deepEqual(tick.worse.map(proc => proc.key), ['sys_watch']);
  const blind = processControlTick(db, { settings, system: { ...sys(0), sys_speed: [] } });
  assert.deepEqual(blind.blind.map(proc => proc.key), ['sys_speed']);
  assert.match(processAlertText(blind), /Нет данных контроля/);
});

test('журналы контроля: ошибки браузера и отказы копятся по суткам; закрытие месяца — срок из настройки', async t => {
  const db = freshDb(t);
  const { closeMonth, controlJournalChecks, recordClientError, recordDenial } = await import('../src/process-control.mjs');
  recordClientError(db, 'Дойкина О', { message: 'TypeError: x is undefined', view: 'dispatcher', source: 'dispatcher.js:10' });
  recordClientError(db, 'Гаев Д', { message: 'TypeError: x is undefined', view: 'dispatcher' });
  recordClientError(db, 'Гаев Д', { message: '' });
  recordDenial(db, 'Базуев Лев', '/api/drivers/:id');
  recordDenial(db, 'Базуев Лев', '/api/drivers/:id');
  const nowMs = Date.parse('2026-11-20T09:00:00Z');
  const cfg = { processControl: { monthCloseDay: 10 } };
  let checks = controlJournalChecks(db, { settings: cfg });
  assert.equal(checks.sys_client[0].value, 1);
  assert.match(checks.sys_client[0].note, /×2/);
  assert.equal(checks.denials[0].value, 1);
  assert.match(checks.denials[0].note, /Базуев Лев → \/api\/drivers\/:id ×2/);
  // 20-е число: срок (10-е) прошёл, октябрь не сверен — красная зона.
  checks = controlJournalChecks(db, { nowMs, settings: cfg });
  assert.deepEqual(checks.month_close.map(item => item.tone), ['neg', 'neg']);
  assert.match(checks.month_close[0].label, /2026-10/);
  assert.ok(closeMonth(db, '2026-10', 'payroll', 'Администратор').ok);
  assert.match(closeMonth(db, '2099-01', 'payroll', 'А').error, /завершённый/);
  checks = controlJournalChecks(db, { nowMs, settings: cfg });
  assert.equal(checks.month_close[0].closed, true);
  assert.equal(checks.month_close[0].tone, '');
  assert.equal(checks.month_close[1].tone, 'neg');
  // До срока — жёлтая, не красная.
  assert.equal(controlJournalChecks(db, { nowMs: Date.parse('2026-11-05T09:00:00Z'), settings: cfg }).month_close[1].tone, 'warn');
});

test('потери в деньгах: простаивающие машины × медиана машино-суток; без норматива денег нет', t => {
  const db = freshDb(t);
  const losses = { assign: { units: 4, label: 'свободные машины без задания' }, tech: { units: 0, label: 'машины в ремонте' } };
  const data = processControl(db, { settings, system: sys(0), losses, dayValue: 18_000 });
  assert.equal(data.processes.find(proc => proc.key === 'assign').loss.perDay, 72_000);
  assert.equal(data.lossTotal, 72_000);
  assert.equal(processControl(db, { settings, system: sys(0), losses, dayValue: null }).lossTotal, 0);
});
