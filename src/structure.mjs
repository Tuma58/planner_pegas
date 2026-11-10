// Структура направления СТ в планере (проект «Слияние», блок 1, решение
// руководителя 05.11.2026): отдел → группа → должность живут ЗДЕСЬ, файл
// «Рабочей среды СТ» — только разовый исходник первой загрузки
// (src/data/st-structure.json, метка org_structure_v1). Дальше структуру
// и паспорта правит руководитель в планере, каждая правка — в журнал.
// Штат должности — ЦЕЛЬ (правится), факт считается из людей: офисные —
// users.position_id, водители — таблица drivers (должность-пул).
// Роль ≠ должность: роль даёт права и назначается руками, должность ставит
// человека в структуру. Сотрудник без роли — без входа и без прав.

import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { rolesOf, ROLE_LABELS } from './permissions.mjs';
import { assignRoleSets, roleSets } from './access.mjs';

const SEED_URL = new URL('./data/st-structure.json', import.meta.url);

export function migrateOrgStructure(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS org_depts (
      key TEXT PRIMARY KEY, name TEXT NOT NULL, coef TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '', sort INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS org_groups (
      id TEXT PRIMARY KEY, dept_key TEXT NOT NULL REFERENCES org_depts(key),
      name TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS org_positions (
      id TEXT PRIMARY KEY, dept_key TEXT NOT NULL REFERENCES org_depts(key),
      group_id TEXT REFERENCES org_groups(id), n INTEGER NOT NULL DEFAULT 0,
      title TEXT NOT NULL, headcount INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT '', driver_pool INTEGER NOT NULL DEFAULT 0,
      passport_json TEXT NOT NULL DEFAULT '{}', archived_at TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );`);
  const userCols = db.prepare(`PRAGMA table_info(users)`).all().map(col => col.name);
  if (!userCols.includes('position_id')) db.exec(`ALTER TABLE users ADD COLUMN position_id TEXT`);
  // Сотрудник без роли (решение 05.11: «создавай всех без ролей и прав,
  // назначу руками»): в CHECK роли добавляется пустая — пересозданием
  // таблицы по её же схеме, как при вводе роли «Механик».
  const usersSql = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='users'`).get()?.sql || '';
  if (usersSql && !usersSql.includes("role IN (''")) {
    const rebuilt = usersSql
      .replace(/CREATE TABLE\s+"?users"?/i, 'CREATE TABLE users_new')
      .replace(/role IN \(/i, "role IN ('',");
    db.exec(`PRAGMA foreign_keys=OFF;
      BEGIN IMMEDIATE;
      ${rebuilt};
      INSERT INTO users_new SELECT * FROM users;
      DROP TABLE users;
      ALTER TABLE users_new RENAME TO users;
      COMMIT;
      PRAGMA foreign_keys=ON;`);
  }
  // Видимость затрат ЦФО по должности (блок 3, решение 07.11): 'all' —
  // общий ЦФО (руководитель направления), 'dept' — затраты своего отдела
  // (руководители отделов, начальники автоколонн, главный механик).
  const posCols = db.prepare(`PRAGMA table_info(org_positions)`).all().map(col => col.name);
  if (!posCols.includes('cfo_view')) db.exec(`ALTER TABLE org_positions ADD COLUMN cfo_view TEXT NOT NULL DEFAULT ''`);
  if (db.prepare(`SELECT 1 FROM app_meta WHERE key='org_structure_v1'`).get()) {
    markCfoView(db);
    return;
  }
  if (!db.prepare(`SELECT COUNT(*) c FROM org_positions`).get().c) {
    const seed = JSON.parse(fs.readFileSync(SEED_URL, 'utf8'));
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const d of seed.depts) {
        db.prepare(`INSERT INTO org_depts(key,name,coef,note,sort) VALUES(?,?,?,?,?)`)
          .run(d.key, d.name, d.coef, d.note, d.sort);
      }
      for (const g of seed.groups) {
        db.prepare(`INSERT INTO org_groups(id,dept_key,name,sort) VALUES(?,?,?,?)`)
          .run(g.id, g.dept, g.name, g.sort);
      }
      for (const p of seed.positions) {
        db.prepare(`INSERT INTO org_positions(id,dept_key,group_id,n,title,headcount,status,
            driver_pool,passport_json) VALUES(?,?,?,?,?,?,?,?,?)`)
          .run(p.id, p.dept, p.group, p.n, p.title, p.headcount, p.status,
            p.driverPool ? 1 : 0, JSON.stringify(p.passport || {}));
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  db.prepare(`INSERT OR IGNORE INTO app_meta(key,value) VALUES('org_structure_v1',?)`)
    .run(JSON.parse(fs.readFileSync(SEED_URL, 'utf8')).version || '1');
  markCfoView(db);
}

function markCfoView(db) {
  if (db.prepare(`SELECT 1 FROM app_meta WHERE key='org_cfo_view_v1'`).get()) { unmarkColumnHead(db); return; }
  // По номеру должности в структуре СТ: 1 — руководитель направления;
  // 5, 9, 14 — руководители отделов (логистика, эксплуатация, ТОиР);
  const mark = db.prepare(`UPDATE org_positions SET cfo_view=? WHERE n=? AND id LIKE 'st-%' AND cfo_view=''`);
  mark.run('all', 1);
  for (const n of [5, 9, 14]) mark.run('dept', n);
  db.prepare(`INSERT OR IGNORE INTO app_meta(key,value) VALUES('org_cfo_view_v1','1')`).run();
  unmarkColumnHead(db);
}

// Уточнение 07.11: начальник автоколонны (n10) — не руководитель отдела,
// затрат ЦФО не видит. Снимается только стартовая отметка.
function unmarkColumnHead(db) {
  if (db.prepare(`SELECT 1 FROM app_meta WHERE key='org_cfo_view_v2'`).get()) return;
  db.prepare(`UPDATE org_positions SET cfo_view='' WHERE n=10 AND id LIKE 'st-%' AND cfo_view='dept'`).run();
  db.prepare(`INSERT OR IGNORE INTO app_meta(key,value) VALUES('org_cfo_view_v2','1')`).run();
}

// Справочник для выбора в карточке сотрудника: компактно, без паспортов.
export function positionOptions(db) {
  return db.prepare(`SELECT p.id, p.title, p.dept_key dept, g.name group_name, p.driver_pool, p.role_set
    FROM org_positions p LEFT JOIN org_groups g ON g.id=p.group_id
    LEFT JOIN org_depts d ON d.key=p.dept_key
    WHERE p.archived_at IS NULL ORDER BY d.sort, g.sort, p.n`).all()
    .map(row => ({ id: row.id, title: row.title, dept: row.dept,
      group: row.group_name || '', driverPool: Boolean(row.driver_pool), roleSet: row.role_set || '' }));
}

export function positionById(db, id) {
  if (!id) return null;
  return db.prepare(`SELECT * FROM org_positions WHERE id=? AND archived_at IS NULL`).get(id) || null;
}

// Отдел сотрудника — по должности (подсветка «мой отдел», цвет аватара).
export function userDept(db, user) {
  if (!user?.position_id) return '';
  return db.prepare(`SELECT dept_key FROM org_positions WHERE id=?`).get(user.position_id)?.dept_key || '';
}

// Обзор структуры: отделы с группами и должностями, у должности штат,
// факт, вакансии и люди. park — канон parkReportData за период (живые
// коэффициенты отделов); не собрался — колонки просто без значения.
export function structureData(db, park = null) {
  const depts = db.prepare(`SELECT * FROM org_depts ORDER BY sort`).all();
  const groups = db.prepare(`SELECT * FROM org_groups ORDER BY sort`).all();
  const positions = db.prepare(`SELECT * FROM org_positions WHERE archived_at IS NULL
    ORDER BY n`).all();
  // Внешние гости (без должности) — не штат: в структуру не входят.
  const users = db.prepare(`SELECT id, full_name, role, roles, active, position_id, job_role
    FROM users WHERE deleted_at IS NULL AND active=1
      AND NOT (COALESCE(guest,0)=1 AND position_id IS NULL)`).all();
  const drivers = db.prepare(`SELECT COUNT(*) c FROM drivers WHERE status<>'fired'`).get().c;
  const byPosition = new Map();
  for (const user of users) {
    if (!user.position_id) continue;
    if (!byPosition.has(user.position_id)) byPosition.set(user.position_id, []);
    const roles = rolesOf(user).filter(Boolean);
    byPosition.get(user.position_id).push({ id: user.id, name: user.full_name, roles,
      roleLabel: roles.map(role => ROLE_LABELS[role] || role).join(' + ') });
  }
  const coefValue = { КТГ: park?.ktg, КВЛ: park?.kvl, КИП: park?.kip, КЭИП: park?.koef };
  const pos = positions.map(p => {
    const people = p.driver_pool ? [] : (byPosition.get(p.id) || [])
      .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    const fact = p.driver_pool ? drivers : people.length;
    let passport = {};
    try { passport = JSON.parse(p.passport_json || '{}'); } catch { passport = {}; }
    return { id: p.id, n: p.n, dept: p.dept_key, group: p.group_id, title: p.title,
      headcount: p.headcount, status: p.status, driverPool: Boolean(p.driver_pool),
      cfoView: p.cfo_view || '', roleSet: p.role_set || '',
      fact, vacancies: Math.max(0, p.headcount - fact), over: Math.max(0, fact - p.headcount),
      people, passport };
  });
  const sum = (list, key) => list.reduce((total, item) => total + item[key], 0);
  const office = pos.filter(p => !p.driverPool);
  const unplaced = users.filter(user => !user.position_id)
    .map(user => ({ id: user.id, name: user.full_name,
      roleLabel: rolesOf(user).filter(Boolean).map(role => ROLE_LABELS[role] || role).join(' + ') }));
  return {
    depts: depts.map(d => {
      const mine = pos.filter(p => p.dept === d.key);
      return { key: d.key, name: d.name, coef: d.coef, note: d.note,
        value: coefValue[d.coef] ?? null,
        headcount: sum(mine, 'headcount'), fact: sum(mine, 'fact'), vacancies: sum(mine, 'vacancies') };
    }),
    groups: groups.map(g => ({ id: g.id, dept: g.dept_key, name: g.name, sort: g.sort })),
    positions: pos,
    totals: {
      headcount: sum(pos, 'headcount'), fact: sum(pos, 'fact'), vacancies: sum(pos, 'vacancies'),
      officeHeadcount: sum(office, 'headcount'), officeFact: sum(office, 'fact'),
      driverHeadcount: sum(pos.filter(p => p.driverPool), 'headcount'), drivers,
      noRole: users.filter(user => !rolesOf(user).filter(Boolean).length).length
    },
    unplaced,
    park: park ? { ktg: park.ktg, kvl: park.kvl, kip: park.kip, koef: park.koef,
      fleet: park.fleet, from: park.from, to: park.to } : null
  };
}

// Срез обзора по области (поле управления, 07.11): руководитель отдела
// видит мини-структуру СВОЕГО отдела — чужие отделы сервер не отдаёт.
export function scopeStructure(data, scope) {
  if (!scope || scope.all) return data;
  const keep = new Set(scope.depts);
  const positions = data.positions.filter(item => keep.has(item.dept));
  const sum = (list, key) => list.reduce((total, item) => total + item[key], 0);
  const office = positions.filter(item => !item.driverPool);
  const drivers = positions.filter(item => item.driverPool);
  return { ...data,
    depts: data.depts.filter(item => keep.has(item.key)),
    groups: data.groups.filter(item => keep.has(item.dept)),
    positions, unplaced: [],
    totals: { headcount: sum(positions, 'headcount'), fact: sum(positions, 'fact'),
      vacancies: sum(positions, 'vacancies'), officeHeadcount: sum(office, 'headcount'),
      officeFact: sum(office, 'fact'), driverHeadcount: sum(drivers, 'headcount'),
      drivers: drivers.length ? data.totals.drivers : 0,
      noRole: office.reduce((n, p) => n + p.people.filter(person => !person.roles.length).length, 0) },
    scoped: true };
}

const PASSPORT_KEYS = ['gen', 'qual', 'know', 'func', 'duties', 'rights', 'inter', 'resp', 'kpi'];

// Правка должности руководителем: название, штат, группа, статус, паспорт.
// Название дублируется в users.job_role людей на должности — на тексте
// должности стоят база нормы «Моей смены», телефония, контакты водителю.
export function updatePosition(db, id, body = {}) {
  const current = positionById(db, id);
  if (!current) return { ok: false, status: 404, error: 'Должность не найдена' };
  const title = body.title != null ? String(body.title).trim() : current.title;
  if (!title) return { ok: false, status: 422, error: 'Название должности пустое' };
  const headcount = body.headcount != null ? Number(body.headcount) : current.headcount;
  if (!Number.isInteger(headcount) || headcount < 0) {
    return { ok: false, status: 422, error: 'Штат — целое число от 0' };
  }
  let groupId = current.group_id;
  if (body.group !== undefined) {
    const group = db.prepare(`SELECT id, dept_key FROM org_groups WHERE id=?`).get(body.group);
    if (!group || group.dept_key !== current.dept_key) {
      return { ok: false, status: 422, error: 'Группа должна быть из того же отдела' };
    }
    groupId = group.id;
  }
  let passport = current.passport_json;
  if (body.passport && typeof body.passport === 'object') {
    const clean = {};
    for (const key of PASSPORT_KEYS) {
      const value = body.passport[key];
      clean[key] = Array.isArray(value) ? value : typeof value === 'string' ? value : [];
    }
    passport = JSON.stringify(clean);
  }
  const cfoView = ['', 'dept', 'all'].includes(body.cfoView) ? body.cfoView : current.cfo_view;
  const roleSet = body.roleSet !== undefined ? String(body.roleSet || '') : (current.role_set || '');
  const setProblem = roleSetProblem(db, roleSet, current.dept_key);
  if (setProblem) return { ok: false, status: 422, error: setProblem };
  db.prepare(`UPDATE org_positions SET title=?, headcount=?, group_id=?, status=?,
      passport_json=?, cfo_view=?, role_set=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(title, headcount, groupId, body.status != null ? String(body.status) : current.status,
      passport, cfoView, roleSet, id);
  // Права должности сменились — по галке «применить к людям» набор
  // переназначается всем на должности (администраторов не трогает).
  let applied = 0;
  if (roleSet && roleSet !== (current.role_set || '') && body.applyToPeople) {
    applied = applyPositionSet(db, id, roleSet);
  }
  if (title !== current.title) {
    db.prepare(`UPDATE users SET job_role=?, updated_at=CURRENT_TIMESTAMP WHERE position_id=?`)
      .run(title, id);
  }
  return { ok: true, applied, before: { title: current.title, headcount: current.headcount, roleSet: current.role_set || '' },
    after: { title, headcount, roleSet } };
}

export function createPosition(db, body = {}) {
  const group = db.prepare(`SELECT id, dept_key FROM org_groups WHERE id=?`).get(body.group);
  if (!group) return { ok: false, status: 422, error: 'Укажите группу' };
  const title = String(body.title || '').trim();
  if (!title) return { ok: false, status: 422, error: 'Название должности пустое' };
  const headcount = Number(body.headcount ?? 1);
  if (!Number.isInteger(headcount) || headcount < 0) {
    return { ok: false, status: 422, error: 'Штат — целое число от 0' };
  }
  const roleSet = String(body.roleSet || '');
  const setProblem = roleSetProblem(db, roleSet, group.dept_key);
  if (setProblem) return { ok: false, status: 422, error: setProblem };
  const n = db.prepare(`SELECT COALESCE(MAX(n),0)+1 n FROM org_positions`).get().n;
  const id = `pos-${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO org_positions(id,dept_key,group_id,n,title,headcount,status,role_set)
    VALUES(?,?,?,?,?,?,?,?)`).run(id, group.dept_key, group.id, n, title, headcount, 'Новая должность', roleSet);
  return { ok: true, id };
}

// Набор должности: пусто — без входа (слесарь, электрик); иначе набор
// существует и не администраторский; отдел набора — отдел должности
// (набор «всё направление» — только у должностей Штаба).
function roleSetProblem(db, roleSet, dept) {
  if (!roleSet) return '';
  const set = roleSets(db).find(item => item.id === roleSet);
  if (!set) return 'Набор прав не найден';
  if (set.codes.includes('admin')) return 'Набор администратора к должности не привязывается';
  if (set.scope && set.scope !== 'all' && set.scope !== dept) return 'Набор другого отдела — выберите набор своего отдела';
  if (set.scope === 'all' && dept !== 'staff') return 'Набор «всё направление» — только для должностей Штаба';
  return '';
}

export function applyPositionSet(db, positionId, roleSet) {
  let count = 0;
  for (const user of db.prepare(`SELECT id, roles FROM users WHERE position_id=? AND deleted_at IS NULL
      AND active=1`).all(positionId)) {
    if (rolesOf(user).includes('admin')) continue;
    if (assignRoleSets(db, user.id, [roleSet]).ok) count += 1;
  }
  return count;
}

// Посев «должность → набор» по утверждённой таблице 9.1 и распределению
// 09.11 (10-roli-shtat.md); дальше набор должности меняет руководитель
// в «Структуре». Разово, меткой; несуществующие должности пропускаются.
const POSITION_SET_SEED = {
  'st-p1': 'dir_head', 'st-p3': 'staff_bdd', 'st-p4': 'staff_aho', 'st-p5': 'guard',
  'st-p6': 'log_head', 'st-p7': 'log_plan', 'st-p8': 'log_assign', 'st-p9': 'log_ctrl',
  'st-p10': 'drv_head', 'st-p11': 'drv_column', 'st-p25': 'drv_acc', 'st-p26': 'drv_tech',
  'st-p16': 'toir_head', 'st-p17': 'toir_mech', 'st-p18': 'toir_mech', 'st-p19': 'toir_mech',
  'st-p20': 'toir_mech', 'st-p23': 'toir_supply', 'st-p24': 'toir_supply', 'st-p30': 'toir_supply'
};
export function migratePositionRoles(db) {
  const cols = db.prepare(`PRAGMA table_info(org_positions)`).all().map(col => col.name);
  if (!cols.includes('role_set')) db.exec(`ALTER TABLE org_positions ADD COLUMN role_set TEXT NOT NULL DEFAULT ''`);
  if (db.prepare(`SELECT 1 FROM app_meta WHERE key='position_role_sets_v1'`).get()) return;
  const known = new Set(roleSets(db).map(set => set.id));
  const update = db.prepare(`UPDATE org_positions SET role_set=? WHERE id=? AND role_set=''`);
  for (const [id, set] of Object.entries(POSITION_SET_SEED)) if (known.has(set)) update.run(set, id);
  db.prepare(`INSERT OR IGNORE INTO app_meta(key,value) VALUES('position_role_sets_v1','1')`).run();
}

// Упразднение — только пустой должности: людей сначала переводят.
export function archivePosition(db, id) {
  const current = positionById(db, id);
  if (!current) return { ok: false, status: 404, error: 'Должность не найдена' };
  if (current.driver_pool) return { ok: false, status: 422, error: 'Должность водителей не упраздняется' };
  const people = db.prepare(`SELECT COUNT(*) c FROM users WHERE position_id=? AND deleted_at IS NULL
    AND active=1`).get(id).c;
  if (people) return { ok: false, status: 422, error: `На должности ${people} чел. — сначала переведите их` };
  db.prepare(`UPDATE org_positions SET archived_at=CURRENT_TIMESTAMP WHERE id=?`).run(id);
  return { ok: true, title: current.title };
}

export function saveGroup(db, body = {}) {
  const name = String(body.name || '').trim();
  if (!name) return { ok: false, status: 422, error: 'Название группы пустое' };
  if (body.id) {
    const found = db.prepare(`SELECT id FROM org_groups WHERE id=?`).get(body.id);
    if (!found) return { ok: false, status: 404, error: 'Группа не найдена' };
    db.prepare(`UPDATE org_groups SET name=? WHERE id=?`).run(name, body.id);
    return { ok: true, id: body.id };
  }
  const dept = db.prepare(`SELECT key FROM org_depts WHERE key=?`).get(body.dept);
  if (!dept) return { ok: false, status: 422, error: 'Укажите отдел' };
  const sort = db.prepare(`SELECT COALESCE(MAX(sort),0)+1 s FROM org_groups WHERE dept_key=?`).get(dept.key).s;
  const id = `grp-${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO org_groups(id,dept_key,name,sort) VALUES(?,?,?,?)`).run(id, dept.key, name, sort);
  return { ok: true, id };
}
