// Перенос «Слияния» в планер ПО ОТДЕЛАМ (решение руководителя 10.11:
// ТОиР → Эксплуатация → Логистика → Штаб). Код выкладывается один раз;
// отдел включается загрузкой его людей из снимка, проверенного
// руководителем в лаборатории (src/data/merger-shtat.json): должность,
// набор прав, увольнения. Учётки прода сопоставляются по ФИО (на проде
// имена короткие: «Токарева В», «Лев Базуев», «Filyunina O»), сомнительные
// и пропущенные — на ручной выбор. Перед записью — снимок прежних прав
// каждого человека; откат отдела возвращает их как было.
// Люди без набора (прочие отделы) живут в прежней модели — не трогаются.

import fs from 'node:fs';
import { assignRoleSets, roleSets } from './access.mjs';
import { translit } from './credentials.mjs';
import { createStaffUser, fireStaffUser } from './staff.mjs';
import { hashPassword } from './security.mjs';

export const MERGER_DEPTS = [['toir', 'ТОиР'], ['drv', 'Эксплуатация'], ['log', 'Логистика'], ['staff', 'Штаб']];
const SNAPSHOT_URL = new URL('./data/merger-shtat.json', import.meta.url);

export function loadSnapshot(url = SNAPSHOT_URL) {
  return JSON.parse(fs.readFileSync(url, 'utf8'));
}

export function migrateMerger(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS merger_access_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dept TEXT NOT NULL,
    user_id TEXT NOT NULL,
    created INTEGER NOT NULL DEFAULT 0,
    before_json TEXT NOT NULL DEFAULT '{}',
    after_json TEXT NOT NULL DEFAULT '{}',
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    applied_by TEXT NOT NULL DEFAULT '',
    rolled_back_at TEXT
  )`);
}

// ── Сопоставление ФИО ──
const norm = text => translit(String(text || '').toLowerCase().replace(/ё/g, 'е'));
const tokens = text => String(text || '').trim().split(/\s+/).filter(Boolean).map(norm).filter(Boolean);
function distance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 9;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

// Насколько прод-учётка похожа на человека из снимка: 'exact' | 'close' | null.
// Варианты прода: «Фамилия И», «Фамилия Имя», «Имя Фамилия», «Имя Ф».
export function nameMatch(staffName, prodName) {
  const [surname, first = ''] = tokens(staffName);
  const prod = tokens(prodName);
  if (!surname || !prod.length) return null;
  const [a, b = ''] = prod;
  const initialOk = (full, part) => !part || full.startsWith(part.slice(0, 1));
  // Фамилия первой.
  if (a === surname && initialOk(first, b) && (!b || b.length <= 2 || first === b || first.startsWith(b))) return 'exact';
  // Имя первым: «Лев Базуев», «Дарья Н».
  if (first && a === first && b && (b === surname || (b.length <= 2 && surname.startsWith(b)))) return 'exact';
  // Опечатка в фамилии (Вахромеева / Вахрамеева) при совпавшем инициале.
  if (a.length > 3 && distance(a, surname) <= 1 && initialOk(first, b)) return 'close';
  return null;
}

// Кандидаты на прод: действующие учётки, кроме служебных.
const SERVICE_LOGINS = new Set(['admin', 'tablo']);
function prodAccounts(db) {
  return db.prepare(`SELECT * FROM users WHERE deleted_at IS NULL AND active=1`).all()
    .filter(user => !SERVICE_LOGINS.has(String(user.username).toLowerCase()))
    .filter(user => !String(user.username).startsWith('emp-'));
}

// План отдела: кто кем станет. overrides: { 'ФИО из снимка': prodUserId | 'new' | 'skip' }.
export function mergerPlan(db, dept, { snapshot = loadSnapshot(), overrides = {} } = {}) {
  const sets = new Map(roleSets(db, { all: true }).map(set => [set.id, set]));
  const positions = new Map(db.prepare(`SELECT id, title, dept_key FROM org_positions`).all().map(p => [p.id, p]));
  const accounts = prodAccounts(db);
  const done = new Set(db.prepare(`SELECT user_id FROM merger_access_log WHERE rolled_back_at IS NULL`).all().map(row => row.user_id));
  const people = snapshot.users.filter(person => person.dept === dept);
  const rows = people.map(person => {
    const override = overrides[person.fullName];
    let match = null;
    let how = '';
    const candidates = accounts
      .map(account => ({ account, kind: nameMatch(person.fullName, account.full_name) }))
      .filter(item => item.kind);
    if (override === 'new') how = 'new';
    else if (override === 'skip') how = 'skip';
    else if (override) {
      match = accounts.find(account => account.id === override) || null;
      how = match ? 'manual' : 'new';
    } else if (candidates.length === 1) {
      match = candidates[0].account;
      how = candidates[0].kind;
    } else if (candidates.length > 1) {
      how = 'ambiguous';
    } else how = 'new';
    // Нет своей учётки на проде, но человек уже создан этим переносом
    // раньше (повторный прогон) — найдём по точному ФИО.
    if (how === 'new') {
      const same = db.prepare(`SELECT * FROM users WHERE deleted_at IS NULL AND full_name=?`).get(person.fullName);
      if (same) { match = same; how = 'exact'; }
    }
    const action = !person.active ? (match ? 'fire' : 'none')
      : how === 'skip' || how === 'ambiguous' ? 'none' : match ? 'update' : 'create';
    return {
      fullName: person.fullName, position: person.position, positionId: person.positionId,
      positionKnown: positions.has(person.positionId),
      roleSets: person.roleSets, roleTitles: person.roleSets.map(id => sets.get(id)?.title || id),
      unknownSets: person.roleSets.filter(id => !sets.has(id)),
      active: person.active, fireReason: person.fireReason || '',
      how, action, applied: Boolean(match && done.has(match.id)),
      prod: match ? { id: match.id, name: match.full_name, username: match.username,
        roles: safeJson(match.roles, []), roleSets: safeJson(match.role_sets, []) } : null,
      candidates: candidates.map(item => ({ id: item.account.id, name: item.account.full_name, kind: item.kind }))
    };
  });
  return {
    dept, rows,
    accounts: accounts.map(account => ({ id: account.id, name: account.full_name, username: account.username })),
    summary: {
      total: rows.length,
      update: rows.filter(row => row.action === 'update').length,
      create: rows.filter(row => row.action === 'create').length,
      fire: rows.filter(row => row.action === 'fire').length,
      attention: rows.filter(row => ['ambiguous', 'close'].includes(row.how) || row.unknownSets.length || !row.positionKnown).length
    }
  };
}

const safeJson = (text, fallback) => { try { return JSON.parse(text || ''); } catch { return fallback; } };
const stateOf = user => ({ roles: user.roles, role: user.role, role_sets: user.role_sets,
  position_id: user.position_id, job_role: user.job_role, active: user.active, fired_at: user.fired_at });

// Применить план отдела. Блокирует, если есть неоднозначные или
// неизвестные наборы/должности (их решает руководитель в таблице).
export function applyMerger(db, dept, { snapshot = loadSnapshot(), overrides = {}, by = '' } = {}) {
  const plan = mergerPlan(db, dept, { snapshot, overrides });
  const blockers = plan.rows.filter(row => row.how === 'ambiguous' || row.unknownSets.length || (!row.positionKnown && row.action !== 'none'));
  if (blockers.length) {
    return { ok: false, status: 422, error: `Сначала решите: ${blockers.map(row => row.fullName).join(', ')}`, plan };
  }
  // Настройки Слияния: только недостающие ключи (значения прода не трогаем).
  const settingsAdded = fillSettings(db, snapshot.settings || {});
  const log = db.prepare(`INSERT INTO merger_access_log(dept,user_id,created,before_json,after_json,applied_by)
    VALUES(?,?,?,?,?,?)`);
  const result = { created: 0, updated: 0, fired: 0, settingsAdded };
  db.exec('BEGIN IMMEDIATE');
  try {
    // Права должностей отдела — как в лаборатории.
    const setPos = db.prepare(`UPDATE org_positions SET role_set=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`);
    for (const position of (snapshot.positions || []).filter(p => p.dept_key === dept && !p.archived_at)) {
      setPos.run(position.role_set || '', position.id);
    }
    for (const row of plan.rows) {
      if (row.action === 'none') continue;
      if (row.action === 'create') {
        const made = createStaffUser(db, { fullName: row.fullName, positionId: row.positionId,
          hiredAt: new Date().toISOString().slice(0, 10) }, { hashPassword });
        if (!made.ok) throw new Error(`${row.fullName}: ${made.error}`);
        if (row.roleSets.length) {
          const assigned = assignRoleSets(db, made.id, row.roleSets);
          if (!assigned.ok) throw new Error(`${row.fullName}: ${assigned.error}`);
        }
        log.run(dept, made.id, 1, '{}', JSON.stringify({ roleSets: row.roleSets, positionId: row.positionId }), by);
        result.created += 1;
        continue;
      }
      const user = db.prepare('SELECT * FROM users WHERE id=?').get(row.prod.id);
      const before = stateOf(user);
      if (row.action === 'fire') {
        fireStaffUser(db, user.id);
        log.run(dept, user.id, 0, JSON.stringify(before), JSON.stringify({ fired: true, reason: row.fireReason }), by);
        result.fired += 1;
        continue;
      }
      const position = db.prepare('SELECT title FROM org_positions WHERE id=?').get(row.positionId);
      db.prepare(`UPDATE users SET position_id=?, job_role=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(row.positionId, position?.title || row.position, user.id);
      const assigned = assignRoleSets(db, user.id, row.roleSets);
      if (!assigned.ok) throw new Error(`${row.fullName}: ${assigned.error}`);
      log.run(dept, user.id, 0, JSON.stringify(before), JSON.stringify({ roleSets: row.roleSets, positionId: row.positionId }), by);
      result.updated += 1;
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    return { ok: false, status: 422, error: error.message, plan };
  }
  return { ok: true, ...result };
}

function fillSettings(db, wanted) {
  const added = [];
  for (const [key, value] of Object.entries(wanted)) {
    if (!value || typeof value !== 'object') continue;
    const row = db.prepare('SELECT value_json FROM settings WHERE key=?').get(key);
    const current = row ? safeJson(row.value_json, {}) : {};
    let changed = false;
    for (const [field, fieldValue] of Object.entries(value)) {
      if (current[field] === undefined) { current[field] = fieldValue; added.push(`${key}.${field}`); changed = true; }
    }
    if (!changed) continue;
    if (row) db.prepare('UPDATE settings SET value_json=? WHERE key=?').run(JSON.stringify(current), key);
    else db.prepare('INSERT INTO settings(key,value_json) VALUES(?,?)').run(key, JSON.stringify(current));
  }
  return added;
}

// Откат отдела: прежние права, должность и статус — из журнала; созданные
// переносом — без роли и входа (в справочнике остаются, история цела).
export function rollbackMerger(db, dept, { by = '' } = {}) {
  const rows = db.prepare(`SELECT * FROM merger_access_log WHERE dept=? AND rolled_back_at IS NULL ORDER BY id DESC`).all(dept);
  if (!rows.length) return { ok: false, status: 422, error: 'Этот отдел ещё не переносился' };
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const row of rows) {
      if (row.created) {
        db.prepare(`UPDATE users SET role_sets='', roles='[]', role='', password_hash='', must_change_password=0,
            updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(row.user_id);
        db.prepare('DELETE FROM sessions WHERE user_id=?').run(row.user_id);
      } else {
        const before = safeJson(row.before_json, {});
        db.prepare(`UPDATE users SET roles=?, role=?, role_sets=?, position_id=?, job_role=?, active=?, fired_at=?,
            updated_at=CURRENT_TIMESTAMP WHERE id=?`)
          .run(before.roles ?? '[]', before.role ?? '', before.role_sets ?? '', before.position_id ?? null,
            before.job_role ?? '', before.active ?? 1, before.fired_at ?? null, row.user_id);
      }
    }
    db.prepare(`UPDATE merger_access_log SET rolled_back_at=CURRENT_TIMESTAMP WHERE dept=? AND rolled_back_at IS NULL`).run(dept);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    return { ok: false, status: 500, error: error.message };
  }
  return { ok: true, restored: rows.length, by };
}

// Статус по отделам для экрана «Перенос».
export function mergerStatus(db) {
  return MERGER_DEPTS.map(([key, title]) => {
    const live = db.prepare(`SELECT COUNT(*) n, MAX(applied_at) at FROM merger_access_log
      WHERE dept=? AND rolled_back_at IS NULL`).get(key);
    return { key, title, applied: live.n > 0, people: live.n, at: live.at || null };
  });
}

