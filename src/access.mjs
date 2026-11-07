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

export const ALL_VIEWS = ['field', 'kpi', 'gate', 'release', 'docs', 'safety', 'logreports', 'toboard', 'payroll', 'crm', 'payments', 'dashboard', 'gantt', 'structure', 'goals', 'cfo', 'boss', 'staff', 'expenses',
  'sales', 'routes', 'delivery', 'flows', 'logist', 'dispatcher', 'monitoring', 'incidents',
  'resource', 'fleetplan', 'remzona'];
// «Моё поле» — первым: поле управления руководителя отдела (Э1, 07.11).
const DEPT_PANELS = ['field', 'structure', 'goals', 'cfo', 'kpi'];
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
    ['sales', 'logist', 'dispatcher'], 'full', 'dept'],
  ['log_plan', 'Специалист группы планирования', 'log', ['sales', 'routes', 'delivery', 'flows', 'gantt'],
    ['sales'], 'rates', ''],
  ['log_assign', 'Логист-диспетчер', 'log', ['logist', 'gantt'], ['logist'], 'rates', ''],
  // Уровень «ставки» (чек-лист 07.11): сверка суммы заказа перед 1С и сбор
  // наличных — прямая работа диспетчера-контролёра; итогов направления нет.
  ['log_ctrl', 'Диспетчер-контролёр', 'log', ['dispatcher', 'monitoring', 'incidents', 'gantt'],
    ['dispatcher'], 'rates', ''],
  ['drv_head', 'Руководитель отдела эксплуатации', 'drv', [...DEPT_PANELS, 'resource', 'fleetplan', 'gantt'],
    ['resource'], 'none', 'dept'],
  // Начальник автоколонны — ПОД руководителем эксплуатации, не
  // руководитель отдела (уточнение руководителя 07.11): рабочие экраны,
  // без поля, панелей отдела и ЦФО.
  ['drv_column', 'Начальник автоколонны', 'drv', ['resource', 'fleetplan', 'gantt'],
    ['resource'], 'none', ''],
  ['drv_acc', 'Диспетчер учёта', 'drv', ['resource', 'docs'], ['resource'], 'none', ''],
  ['toir_head', 'Главный механик', 'toir', [...DEPT_PANELS, 'remzona'], ['mechanic'], 'none', 'dept'],
  ['toir_mech', 'Механик / оператор / старший смены', 'toir', ['remzona'], ['mechanic'], 'none', ''],
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
