// Роли-наборы и область (проект «Слияние», «Поле управления», утверждено
// руководителем 07.11.2026). Роль = НАБОР под должность: область (свой
// отдел или всё направление) + экраны + коды прав + уровень денег +
// видимость ЦФО. Набор собирается ПОВЕРХ прежних кодов ролей
// (users.roles: sales/logist/dispatcher/resource/mechanic/manager/
// accountant/admin) — на них держатся права, адресаты уведомлений
// notify(...), отметки задач и автораздача доски; при назначении набора
// его коды пишутся в users.roles, поэтому всё прежнее работает как было.
// Чужие отделы скрыты полностью: коммерческую тайну охраняет СЕРВЕР —
// сводные API отдают только область, стартовая выдача режет деньги по
// уровню набора. Пользователь без наборов (переходный период, учётки
// прода до назначения) живёт по-старому: права ролей, всё направление.

import { ROLE_LABELS, rolesOf } from './permissions.mjs';

export const ALL_VIEWS = ['arm', 'field', 'kpi', 'gate', 'release', 'docs', 'safety', 'logreports', 'reports', 'toboard', 'payroll', 'crm', 'payments', 'parts', 'dashboard', 'gantt', 'structure', 'goals', 'cfo', 'boss', 'staff', 'expenses',
  'sales', 'routes', 'delivery', 'flows', 'logist', 'dispatcher', 'monitoring', 'incidents',
  'resource', 'fleetplan', 'remzona'];
// «Моё поле» — первым: поле управления руководителя отдела (Э1, 07.11).
const DEPT_PANELS = ['field', 'structure', 'goals', 'cfo', 'kpi', 'reports'];
// Уровни денег: full — выручка, планы, прогноз, претензии; rates —
// ставки рейсов и заявок (работа логиста/планирования), без итогов
// направления; none — без денег вовсе.
export const MONEY_LEVELS = ['full', 'rates', 'none'];

// Посев — утверждённая таблица 9.1 (00-pole-upravleniya.md).
const SEED = [
  ['dir_head', 'Руководитель направления', 'all', ALL_VIEWS.filter(v => v !== 'expenses'),
    ['manager', 'sales', 'logist', 'dispatcher', 'resource', 'mechanic'], 'full', 'all'],
  ['log_head', 'Руководитель отдела логистики', 'log',
    [...DEPT_PANELS, 'sales', 'routes', 'delivery', 'flows', 'logist', 'gantt', 'dispatcher', 'monitoring', 'incidents'],
    ['sales', 'logist', 'dispatcher', 'reports'], 'full', 'dept'],
  ['log_plan', 'Специалист группы планирования', 'log', ['sales', 'routes', 'delivery', 'flows', 'gantt'],
    ['sales'], 'rates', ''],
  ['log_assign', 'Логист-диспетчер', 'log', ['arm', 'logist', 'gantt'], ['logist'], 'rates', ''],
  // Уровень «ставки» (чек-лист 07.11): сверка суммы заказа перед 1С и сбор
  // наличных — прямая работа диспетчера-контролёра; итогов направления нет.
  ['log_ctrl', 'Диспетчер-контролёр', 'log', ['arm', 'dispatcher', 'monitoring', 'incidents', 'gantt'],
    ['dispatcher'], 'rates', ''],
  ['drv_head', 'Руководитель отдела эксплуатации', 'drv', [...DEPT_PANELS, 'resource', 'fleetplan', 'gantt'],
    ['resource', 'reports'], 'none', 'dept'],
  // Начальник автоколонны — ПОД руководителем эксплуатации, не
  // руководитель отдела (уточнение руководителя 07.11): рабочие экраны,
  // без поля, панелей отдела и ЦФО.
  ['drv_column', 'Начальник автоколонны', 'drv', ['resource', 'fleetplan', 'gantt'],
    ['resource'], 'none', ''],
  ['drv_acc', 'Диспетчер учёта', 'drv', ['arm', 'resource', 'docs'], ['resource'], 'none', ''],
  ['toir_head', 'Главный механик', 'toir', [...DEPT_PANELS, 'remzona', 'toboard', 'parts'], ['mechanic', 'reports'], 'none', 'dept'],
  ['toir_mech', 'Механик / оператор / старший смены', 'toir', ['arm', 'remzona', 'toboard', 'parts'], ['mechanic'], 'none', ''],
  // Снабжение ТОиР (закупщик, кладовщик, снабженец): склад и Ремзона;
  // цены склада — по набору (partsRights), выручки рейсов не видит.
  ['toir_supply', 'Снабжение ТОиР', 'toir', ['parts', 'remzona'], ['mechanic'], 'none', ''],
  ['accountant', 'Бухгалтерия', '', ['gantt', 'docs'], ['accountant'], 'rates', ''],
  ['guard', 'Охранник-парковщик', 'staff', ['gate'], ['guard'], 'none', ''],
  ['drv_tech', 'Контролёр техсостояния', 'drv', ['release'], ['techctl'], 'none', ''],
  // Чек-лист 07.11: инструменты штата, которых не было.
  ['staff_bdd', 'Специалист БДД', 'staff', ['safety', 'release', 'incidents'], ['safety'], 'none', ''],
  ['staff_aho', 'Специалист АХО', 'staff', ['gate'], ['guard'], 'none', ''],
  ['admin', 'Администратор', 'all', ALL_VIEWS, ['admin'], 'full', 'all']
];

export function migrateAccess(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS role_sets (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, scope TEXT NOT NULL DEFAULT '',
    views_json TEXT NOT NULL DEFAULT '[]', codes_json TEXT NOT NULL DEFAULT '[]',
    money TEXT NOT NULL DEFAULT 'none' CHECK(money IN ('full','rates','none')),
    cfo TEXT NOT NULL DEFAULT '' CHECK(cfo IN ('','dept','all')),
    sort INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  const cols = db.prepare(`PRAGMA table_info(users)`).all().map(col => col.name);
  if (!cols.includes('role_sets')) db.exec(`ALTER TABLE users ADD COLUMN role_sets TEXT NOT NULL DEFAULT ''`);
  if (db.prepare(`SELECT 1 FROM app_meta WHERE key='role_sets_v1'`).get()) {
    migrateFieldView(db);
    migrateColumnHead(db);
    migrateKpiView(db);
    migrateGuard(db);
    migrateRelease(db);
    migrateCtrlRates(db);
    migrateChecklist(db);
    migrateChecklistV3(db);
    migrateHeadReports(db);
    migrateArm(db);
    migrateArmAll(db);
    migrateSupplyMoney(db);
    migrateLogTrips(db);
    return;
  }
  const insert = db.prepare(`INSERT OR IGNORE INTO role_sets(id,title,scope,views_json,codes_json,money,cfo,sort)
    VALUES(?,?,?,?,?,?,?,?)`);
  SEED.forEach(([id, title, scope, views, codes, money, cfo], index) =>
    insert.run(id, title, scope, JSON.stringify(views), JSON.stringify(codes), money, cfo, index + 1));
  db.prepare(`INSERT OR IGNORE INTO app_meta(key,value) VALUES('role_sets_v1','1')`).run();
  migrateFieldView(db);
  migrateColumnHead(db);
  migrateKpiView(db);
  migrateGuard(db);
  migrateRelease(db);
  migrateCtrlRates(db);
  migrateChecklist(db);
  migrateLogTrips(db);
}

// Уточнение 07.11: четыре руководителя — направления, логистики, ремзоны
// (главный механик), эксплуатации. Начальник автоколонны — подчинённый:
// у набора снимаются поле, панели отдела и ЦФО (разово, меткой).
function migrateColumnHead(db) {
  if (db.prepare(`SELECT 1 FROM app_meta WHERE key='role_sets_column_v1'`).get()) return;
  const row = db.prepare(`SELECT views_json FROM role_sets WHERE id='drv_column'`).get();
  if (row) {
    const views = parse(row.views_json, []).filter(view => !DEPT_PANELS.includes(view));
    db.prepare(`UPDATE role_sets SET views_json=?, cfo='' WHERE id='drv_column'`).run(JSON.stringify(views));
  }
  db.prepare(`INSERT OR IGNORE INTO app_meta(key,value) VALUES('role_sets_column_v1','1')`).run();
}

// Э1 (07.11): «Моё поле» добавляется в наборы руководителей (у кого есть
// панели отдела) и в наборы всего направления — разово, правки целы.
// Блок 4 (07.11): панель «KPI и каскад» — тем, у кого есть панели отдела.
function migrateKpiView(db) {
  if (db.prepare(`SELECT 1 FROM app_meta WHERE key='role_sets_kpi_v1'`).get()) return;
  for (const row of db.prepare(`SELECT id, views_json FROM role_sets`).all()) {
    const views = parse(row.views_json, []);
    if (views.includes('kpi') || !views.includes('structure')) continue;
    db.prepare(`UPDATE role_sets SET views_json=? WHERE id=?`).run(JSON.stringify([...views, 'kpi']), row.id);
  }
  db.prepare(`INSERT OR IGNORE INTO app_meta(key,value) VALUES('role_sets_kpi_v1','1')`).run();
}

// КПП (07.11): роль «Охранник-парковщик» (код guard) и экран «КПП» у
// Штаба. Код guard добавляется в CHECK роли users пересозданием таблицы —
// как при вводе роли «Механик».
// Новый код роли в CHECK users — пересозданием таблицы по её же схеме.
function ensureRoleCode(db, code) {
  const usersSql = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='users'`).get()?.sql || '';
  if (usersSql && !usersSql.includes(`'${code}'`)) {
    const rebuilt = usersSql.replace(/CREATE TABLE\s+"?users"?/i, 'CREATE TABLE users_new')
      .replace(/role IN \(/i, `role IN ('${code}',`);
    db.exec(`PRAGMA foreign_keys=OFF;
      BEGIN IMMEDIATE;
      ${rebuilt};
      INSERT INTO users_new SELECT * FROM users;
      DROP TABLE users;
      ALTER TABLE users_new RENAME TO users;
      COMMIT;
      PRAGMA foreign_keys=ON;`);
  }
}

function migrateGuard(db) {
  ensureRoleCode(db, 'guard');
  if (db.prepare(`SELECT 1 FROM app_meta WHERE key='role_sets_guard_v1'`).get()) return;
  db.prepare(`INSERT OR IGNORE INTO role_sets(id,title,scope,views_json,codes_json,money,cfo,sort)
    VALUES('guard','Охранник-парковщик','staff','["gate"]','["guard"]','none','',11)`).run();
  for (const row of db.prepare(`SELECT id, views_json FROM role_sets WHERE id IN ('dir_head','admin')`).all()) {
    const views = parse(row.views_json, []);
    if (!views.includes('gate')) db.prepare(`UPDATE role_sets SET views_json=? WHERE id=?`).run(JSON.stringify([...views, 'gate']), row.id);
  }
  db.prepare(`INSERT OR IGNORE INTO app_meta(key,value) VALUES('role_sets_guard_v1','1')`).run();
}

// «Выпуск» (П2, 07.11): роль «Контролёр техсостояния» (код techctl) и
// экран у Эксплуатации и Штаба.
function migrateRelease(db) {
  ensureRoleCode(db, 'techctl');
  if (db.prepare(`SELECT 1 FROM app_meta WHERE key='role_sets_release_v1'`).get()) return;
  db.prepare(`INSERT OR IGNORE INTO role_sets(id,title,scope,views_json,codes_json,money,cfo,sort)
    VALUES('drv_tech','Контролёр техсостояния','drv','["release"]','["techctl"]','none','',9)`).run();
  for (const row of db.prepare(`SELECT id, views_json FROM role_sets
      WHERE id IN ('dir_head','admin','drv_head','drv_column','drv_acc')`).all()) {
    const views = parse(row.views_json, []);
    if (!views.includes('release')) db.prepare(`UPDATE role_sets SET views_json=? WHERE id=?`).run(JSON.stringify([...views, 'release']), row.id);
  }
  db.prepare(`INSERT OR IGNORE INTO app_meta(key,value) VALUES('role_sets_release_v1','1')`).run();
}

// Чек-лист продукта 07.11: диспетчеру-контролёру «без денег» → «ставки»
// (иначе в сверке суммы и наличных 0 ₽). Правка руководителя набора — цела.
function migrateCtrlRates(db) {
  if (db.prepare(`SELECT 1 FROM app_meta WHERE key='role_sets_ctrl_rates_v1'`).get()) return;
  db.prepare(`UPDATE role_sets SET money='rates' WHERE id='log_ctrl' AND money='none'`).run();
  db.prepare(`INSERT OR IGNORE INTO app_meta(key,value) VALUES('role_sets_ctrl_rates_v1','1')`).run();
}

// Чек-лист продукта 07.11: «Документы» (П5) — учёту эксплуатации и
// бухгалтерии; «Безопасность движения» и роли БДД/АХО; «Отчёты отдела» —
// руководителю логистики. Разово, правки руководителя в наборах целы.
function migrateChecklist(db) {
  ensureRoleCode(db, 'safety');
  if (db.prepare(`SELECT 1 FROM app_meta WHERE key='role_sets_checklist_v2'`).get()) return;
  const insert = db.prepare(`INSERT OR IGNORE INTO role_sets(id,title,scope,views_json,codes_json,money,cfo,sort)
    VALUES(?,?,?,?,?,?,?,?)`);
  insert.run('staff_bdd', 'Специалист БДД', 'staff', '["safety","release","incidents"]', '["safety"]', 'none', '', 2);
  insert.run('staff_aho', 'Специалист АХО', 'staff', '["gate"]', '["guard"]', 'none', '', 3);
  const add = (id, view) => {
    const row = db.prepare(`SELECT views_json FROM role_sets WHERE id=?`).get(id);
    if (!row) return;
    const views = parse(row.views_json, []);
    if (!views.includes(view)) db.prepare(`UPDATE role_sets SET views_json=? WHERE id=?`).run(JSON.stringify([...views, view]), id);
  };
  for (const id of ['drv_acc', 'drv_head', 'drv_column', 'dir_head', 'admin', 'accountant']) add(id, 'docs');
  for (const id of ['dir_head', 'admin']) { add(id, 'safety'); add(id, 'logreports'); }
  add('log_head', 'logreports');
  // Карточка ТС и ТО по парку — ТОиР и эксплуатация; ФОТ — Штаб; CRM —
  // планирование и руководитель логистики; «К оплате» — бухгалтерия.
  for (const id of ['toir_head', 'toir_mech', 'drv_head', 'dir_head', 'admin']) add(id, 'toboard');
  for (const id of ['dir_head', 'admin']) { add(id, 'payroll'); add(id, 'crm'); add(id, 'payments'); }
  for (const id of ['log_head', 'log_plan']) add(id, 'crm');
  add('accountant', 'payments');
  db.prepare(`INSERT OR IGNORE INTO app_meta(key,value) VALUES('role_sets_checklist_v2','1')`).run();
}

// Доведение 07.11 (вечер): «Мои отчёты» — руководителям отделов и
// направления; «ФОТ водителей» — руководителю эксплуатации (решение
// руководителя); склад запчастей — ТОиР и набор «Снабжение ТОиР».
function migrateChecklistV3(db) {
  if (db.prepare(`SELECT 1 FROM app_meta WHERE key='role_sets_checklist_v3'`).get()) return;
  db.prepare(`INSERT OR IGNORE INTO role_sets(id,title,scope,views_json,codes_json,money,cfo,sort)
    VALUES(?,?,?,?,?,?,?,?)`).run('toir_supply', 'Снабжение ТОиР', 'toir', '["parts","remzona"]', '["mechanic"]', 'none', '', 4);
  const add = (id, view) => {
    const row = db.prepare(`SELECT views_json FROM role_sets WHERE id=?`).get(id);
    if (!row) return;
    const views = parse(row.views_json, []);
    if (!views.includes(view)) db.prepare(`UPDATE role_sets SET views_json=? WHERE id=?`).run(JSON.stringify([...views, view]), id);
  };
  for (const id of ['dir_head', 'log_head', 'drv_head', 'toir_head', 'admin']) add(id, 'reports');
  add('drv_head', 'payroll');
  for (const id of ['toir_head', 'toir_mech', 'dir_head', 'admin']) add(id, 'parts');
  db.prepare(`INSERT OR IGNORE INTO app_meta(key,value) VALUES('role_sets_checklist_v3','1')`).run();
}

// Отчёты с ценами руководителям отделов (решение 07.11): код «reports»
// (reports:read) в наборы логистики, эксплуатации и ТОиР; коды людей с
// этими наборами пересчитываются. Деньги рабочих экранов — прежние.
function migrateHeadReports(db) {
  ensureRoleCode(db, 'reports');
  if (db.prepare(`SELECT 1 FROM app_meta WHERE key='role_sets_head_reports_v1'`).get()) return;
  for (const id of ['log_head', 'drv_head', 'toir_head']) {
    const row = db.prepare(`SELECT codes_json FROM role_sets WHERE id=?`).get(id);
    if (!row) continue;
    const codes = parse(row.codes_json, []);
    if (!codes.includes('reports')) db.prepare(`UPDATE role_sets SET codes_json=? WHERE id=?`).run(JSON.stringify([...codes, 'reports']), id);
  }
  for (const user of db.prepare(`SELECT id, role_sets FROM users WHERE role_sets<>''`).all()) {
    const sets = parse(user.role_sets, []);
    if (sets.some(id => ['log_head', 'drv_head', 'toir_head'].includes(id))) assignRoleSets(db, user.id, sets, { allowAdmin: true });
  }
  db.prepare(`INSERT OR IGNORE INTO app_meta(key,value) VALUES('role_sets_head_reports_v1','1')`).run();
}

// АРМ, этап Э1 (план 08-arm.md, утверждён 07.11): экран «Моё рабочее
// место» — пилотным наборам (логист-диспетчер, диспетчер-контролёр,
// диспетчер учёта, механик) первым экраном.
function migrateArm(db) {
  if (db.prepare(`SELECT 1 FROM app_meta WHERE key='role_sets_arm_v1'`).get()) return;
  for (const id of ['log_assign', 'log_ctrl', 'drv_acc', 'toir_mech']) {
    const row = db.prepare(`SELECT views_json FROM role_sets WHERE id=?`).get(id);
    if (!row) continue;
    const views = parse(row.views_json, []);
    if (!views.includes('arm')) db.prepare(`UPDATE role_sets SET views_json=? WHERE id=?`).run(JSON.stringify(['arm', ...views]), id);
  }
  db.prepare(`INSERT OR IGNORE INTO app_meta(key,value) VALUES('role_sets_arm_v1','1')`).run();
}

// АРМ, Э2 (07.11): задачи коллегам и от руководителя — у каждого, значит
// «Моё рабочее место» есть во всех наборах (наполнение по должности —
// по мере Э3; пока у непилотных работает зона «Задачи»).
// Чек-лист 07.11 (финальный): у снабжения уровень «ставки» открывал выручку
// рейсов в стартовой выдаче — уровень «без денег», цены склада по набору.
function migrateSupplyMoney(db) {
  if (db.prepare(`SELECT 1 FROM app_meta WHERE key='role_sets_supply_money_v1'`).get()) return;
  db.prepare(`UPDATE role_sets SET money='none' WHERE id='toir_supply'`).run();
  db.prepare(`INSERT OR IGNORE INTO app_meta(key,value) VALUES('role_sets_supply_money_v1','1')`).run();
}

// Решение руководителя 11.11 (перед включением Логистики): «уйти от
// логистики должен только Ресурс, они управляют рейсами — всё остальное
// должно остаться». Наборы логистики получают все три кода управления
// рейсами (заявки, рейсы, отметки) и все рабочие экраны логистики;
// различие должностей — в рабочем месте (АРМ). Правка Ресурса
// (fleet:write) остаётся только у Эксплуатации. Людям с этими наборами
// коды в users.roles пересобираются.
const LOG_TRIP_SETS = ['log_plan', 'log_assign', 'log_ctrl'];
const LOG_TRIP_CODES = ['sales', 'logist', 'dispatcher'];
const LOG_TRIP_VIEWS = ['sales', 'routes', 'delivery', 'flows', 'logist', 'dispatcher', 'monitoring', 'incidents', 'gantt'];
function migrateLogTrips(db) {
  if (db.prepare(`SELECT 1 FROM app_meta WHERE key='role_sets_log_trips_v1'`).get()) return;
  for (const id of LOG_TRIP_SETS) {
    const row = db.prepare(`SELECT views_json, codes_json FROM role_sets WHERE id=?`).get(id);
    if (!row) continue;
    const views = [...new Set([...parse(row.views_json, []), ...LOG_TRIP_VIEWS])];
    const codes = [...new Set([...parse(row.codes_json, []), ...LOG_TRIP_CODES])];
    db.prepare(`UPDATE role_sets SET views_json=?, codes_json=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(JSON.stringify(views), JSON.stringify(codes), id);
  }
  for (const user of db.prepare(`SELECT id, role_sets FROM users WHERE role_sets<>''`).all()) {
    const ids = parse(user.role_sets, []);
    if (Array.isArray(ids) && ids.some(id => LOG_TRIP_SETS.includes(id))) assignRoleSets(db, user.id, ids, { allowAdmin: true });
  }
  db.prepare(`INSERT OR IGNORE INTO app_meta(key,value) VALUES('role_sets_log_trips_v1','1')`).run();
}

function migrateArmAll(db) {
  if (db.prepare(`SELECT 1 FROM app_meta WHERE key='role_sets_arm_v2'`).get()) return;
  for (const row of db.prepare(`SELECT id, views_json FROM role_sets`).all()) {
    const views = parse(row.views_json, []);
    if (!views.includes('arm')) db.prepare(`UPDATE role_sets SET views_json=? WHERE id=?`).run(JSON.stringify([...views, 'arm']), row.id);
  }
  db.prepare(`INSERT OR IGNORE INTO app_meta(key,value) VALUES('role_sets_arm_v2','1')`).run();
}

function migrateFieldView(db) {
  if (db.prepare(`SELECT 1 FROM app_meta WHERE key='role_sets_field_v1'`).get()) return;
  for (const row of db.prepare(`SELECT id, views_json FROM role_sets`).all()) {
    const views = parse(row.views_json, []);
    if (views.includes('field') || !(views.includes('structure') || row.id === 'admin')) continue;
    db.prepare(`UPDATE role_sets SET views_json=? WHERE id=?`).run(JSON.stringify(['field', ...views]), row.id);
  }
  db.prepare(`INSERT OR IGNORE INTO app_meta(key,value) VALUES('role_sets_field_v1','1')`).run();
}

const parse = (text, fallback) => { try { return JSON.parse(text || ''); } catch { return fallback; } };

export function roleSets(db, { all = false } = {}) {
  return db.prepare(`SELECT * FROM role_sets ${all ? '' : 'WHERE active=1'} ORDER BY sort`).all()
    .map(row => ({ id: row.id, title: row.title, scope: row.scope, views: parse(row.views_json, []),
      codes: parse(row.codes_json, []), money: row.money, cfo: row.cfo, active: Boolean(row.active) }));
}

export function userSetIds(user) {
  const ids = parse(user?.role_sets, []);
  return Array.isArray(ids) ? ids.filter(Boolean) : [];
}

const RANK = { full: 3, rates: 2, none: 1 };

// Доступ пользователя: область, экраны, уровень денег, ЦФО. Наборов нет —
// прежняя модель (всё направление, экраны по правам, деньги видны).
export function accessOf(db, user) {
  const ids = userSetIds(user);
  if (!ids.length) {
    return { sets: [], legacy: true, scope: { all: true, depts: ['staff', 'log', 'drv', 'toir'] },
      views: null, money: rolesOf(user).filter(Boolean).length ? 'full' : 'none', cfo: '' };
  }
  const byId = new Map(roleSets(db).map(set => [set.id, set]));
  const sets = ids.map(id => byId.get(id)).filter(Boolean);
  const all = sets.some(set => set.scope === 'all');
  const depts = all ? ['staff', 'log', 'drv', 'toir'] : [...new Set(sets.map(set => set.scope).filter(Boolean))];
  const money = sets.reduce((best, set) => RANK[set.money] > RANK[best] ? set.money : best, 'none');
  const cfo = sets.some(set => set.cfo === 'all') ? 'all' : sets.some(set => set.cfo === 'dept') ? 'dept' : '';
  return { sets: sets.map(set => set.id), setTitles: sets.map(set => set.title), legacy: false,
    scope: { all, depts }, views: [...new Set(sets.flatMap(set => set.views))], money, cfo };
}

// Кто вправе выдать наборы (аудит OWASP 14.11): кадровик с доступом к
// штату мог назначить СЕБЕ «Руководителя направления» (все права записи,
// деньги «все», ЦФО «все»). Правило: свои наборы меняет только
// администратор; не-администратор не выдаёт набор шире своего доступа —
// по уровню денег, области («всё направление») и ЦФО. Возврат — текст
// отказа или ''. targetId = null — назначение через должность.
const CFO_RANK = { all: 3, dept: 2, '': 1 };
export function grantProblem(db, actor, targetId, ids, { isAdmin = false } = {}) {
  if (isAdmin) return '';
  if (targetId && String(targetId) === String(actor?.id)) return 'Свои права меняет только администратор';
  const own = accessOf(db, actor);
  const byId = new Map(roleSets(db).map(set => [set.id, set]));
  for (const id of (Array.isArray(ids) ? ids : []).filter(Boolean)) {
    const set = byId.get(id);
    if (!set) continue; // неизвестный набор отклонит assignRoleSets
    if (set.codes.includes('admin')) return 'Роль «Администратор» назначает только администратор';
    const wider = RANK[set.money] > RANK[own.money]
      || (set.scope === 'all' && !own.scope.all)
      || (CFO_RANK[set.cfo || ''] > CFO_RANK[own.cfo || '']);
    if (wider) return `Набор «${set.title}» шире ваших прав — его назначает администратор или руководитель направления`;
  }
  return '';
}

// Назначение наборов сотруднику: коды прав набора пишутся в users.roles
// (мост к прежней модели), набор — в users.role_sets. Пусто — без роли и
// без входа. Набор с кодом admin назначает только администратор.
export function assignRoleSets(db, userId, ids, { allowAdmin = false } = {}) {
  const byId = new Map(roleSets(db).map(set => [set.id, set]));
  const clean = [...new Set((Array.isArray(ids) ? ids : []).filter(id => byId.has(id)))];
  if ((Array.isArray(ids) ? ids : []).some(id => !byId.has(id))) return { ok: false, error: 'Неизвестная роль' };
  const codes = [...new Set(clean.flatMap(id => byId.get(id).codes))].filter(code => ROLE_LABELS[code]);
  if (!allowAdmin && codes.includes('admin')) return { ok: false, error: 'Роль «Администратор» назначает только администратор' };
  db.prepare(`UPDATE users SET role_sets=?, roles=?, role=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(clean.length ? JSON.stringify(clean) : '', JSON.stringify(codes), codes[0] || '', userId);
  return { ok: true, sets: clean, codes };
}

// ── Вырезка денег из стартовой выдачи (уровень набора) ──
const TRIP_MONEY = ['revenue_vat', 'demurrage_vat', 'cash'];
const ORDER_MONEY = ['rate_vat', 'cash'];
export function stripTrips(rows, money) {
  if (money !== 'none') return rows;
  return rows.map(row => { const copy = { ...row }; for (const key of TRIP_MONEY) copy[key] = null; return copy; });
}
export function stripOrders(rows, money) {
  if (money !== 'none') return rows;
  return rows.map(row => { const copy = { ...row }; for (const key of ORDER_MONEY) copy[key] = null; return copy; });
}
// Мелкие секции: итоги направления (план выручки, прогноз) — только
// full; претензии за простой выставляет планирование — у rates остаются;
// у none нет ни претензий, ни денежной цели маршрута.
export function stripSmall(shared, money) {
  if (money === 'full') return shared;
  const copy = { ...shared, revenuePlans: [], forecastSnapshot: null };
  if (money === 'none') {
    copy.demurrage = null;
    copy.routes = (shared.routes || []).map(route => ({ ...route, target_per_day: null }));
  }
  return copy;
}

// Текст рассылки для сотрудника по уровню денег его роли (утечка закрыта
// 07.11): money 'full' — полный текст только уровню «все», остальным —
// plain (версия без денег) или ничего (null).
export function broadcastTextFor(db, user, text, { money = '', plain = null } = {}) {
  if (money !== 'full') return text;
  return accessOf(db, user).money === 'full' ? text : plain;
}

// ── Свои наборы (заказ руководителя 10.11: «новая должность с
// назначением прав») ──
// Новый набор собирается НА ОСНОВЕ существующего: коды прав (что
// сотрудник может менять) наследуются от основы, руководитель выбирает
// экраны и уровень денег. Код admin в свой набор не переходит; уровень
// денег не выше, чем у того, кто создаёт. Область — отдел основы.
const MONEY_RANK = { full: 3, rates: 2, none: 1 };

function cleanSetBody(body, base, creatorMoney) {
  const views = (Array.isArray(body?.views) ? body.views : base.views).filter(view => ALL_VIEWS.includes(view));
  if (!views.length) return { error: 'Отметьте хотя бы один экран' };
  const money = MONEY_LEVELS.includes(body?.money) ? body.money : base.money;
  if (MONEY_RANK[money] > MONEY_RANK[creatorMoney || 'none']) {
    return { error: 'Уровень денег не может быть выше вашего' };
  }
  return { views: [...new Set(views)], money };
}

export function createRoleSet(db, body, { creatorMoney = 'none' } = {}) {
  const title = String(body?.title || '').trim();
  if (!title) return { ok: false, status: 422, error: 'Название набора пустое' };
  const base = roleSets(db).find(set => set.id === body?.base);
  if (!base) return { ok: false, status: 422, error: 'Выберите основу — существующий набор' };
  if (base.codes.includes('admin')) return { ok: false, status: 422, error: 'Набор администратора не может быть основой' };
  if (roleSets(db).some(set => set.title.toLowerCase() === title.toLowerCase())) {
    return { ok: false, status: 422, error: 'Набор с таким названием уже есть' };
  }
  const clean = cleanSetBody(body, base, creatorMoney);
  if (clean.error) return { ok: false, status: 422, error: clean.error };
  const id = `rs-${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
  const sort = db.prepare(`SELECT COALESCE(MAX(sort),0)+1 s FROM role_sets`).get().s;
  db.prepare(`INSERT INTO role_sets(id,title,scope,views_json,codes_json,money,cfo,sort)
    VALUES(?,?,?,?,?,?,?,?)`).run(id, title, base.scope, JSON.stringify(clean.views),
    JSON.stringify(base.codes), clean.money, base.cfo === 'all' ? 'dept' : base.cfo, sort);
  return { ok: true, id };
}

// Правка своего набора: название, экраны, деньги. Посевные наборы
// (утверждённая таблица) здесь не меняются — только свои «rs-…».
export function updateRoleSet(db, id, body, { creatorMoney = 'none' } = {}) {
  const set = roleSets(db, { all: true }).find(item => item.id === id);
  if (!set) return { ok: false, status: 404, error: 'Набор не найден' };
  if (!id.startsWith('rs-')) return { ok: false, status: 422, error: 'Утверждённые наборы не правятся — создайте свой на их основе' };
  const title = body?.title != null ? String(body.title).trim() : set.title;
  if (!title) return { ok: false, status: 422, error: 'Название набора пустое' };
  const clean = cleanSetBody(body, set, creatorMoney);
  if (clean.error) return { ok: false, status: 422, error: clean.error };
  db.prepare(`UPDATE role_sets SET title=?, views_json=?, money=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(title, JSON.stringify(clean.views), clean.money, id);
  return { ok: true };
}
