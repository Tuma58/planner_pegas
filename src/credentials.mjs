// Выдача доступа и пароли (заказ руководителя 10.11): логин и временный
// пароль генерируются автоматически из справочника сотрудников, при
// первом входе сотрудник обязан придумать свой пароль; дальше меняет его
// сам. Гость — внешний человек (аудитор, собственник, партнёр) с
// просмотром по выбранному набору и сроком доступа.
//
// Пароль хранится только хэшем (scrypt) — временный показывается ОДИН
// раз в ответе на выдачу; повторно его не увидит никто, только сброс.

import { randomInt, randomUUID } from 'node:crypto';
import { rolesOf } from './permissions.mjs';
import { assignRoleSets } from './access.mjs';

export function migrateCredentials(db) {
  const cols = db.prepare(`PRAGMA table_info(users)`).all().map(col => col.name);
  if (!cols.includes('must_change_password')) {
    db.exec(`ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0`);
  }
  if (!cols.includes('password_changed_at')) db.exec(`ALTER TABLE users ADD COLUMN password_changed_at TEXT`);
  // Гость: срок доступа (включительно, дата ГГГГ-ММ-ДД) и кто/зачем.
  if (!cols.includes('guest_until')) db.exec(`ALTER TABLE users ADD COLUMN guest_until TEXT`);
  if (!cols.includes('guest_note')) db.exec(`ALTER TABLE users ADD COLUMN guest_note TEXT NOT NULL DEFAULT ''`);
}

// ── Логин из ФИО: «Токарева Вера» → tokareva.v ──
const TR = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh',
  ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };

export function translit(text) {
  return [...String(text || '').toLowerCase()].map(ch => TR[ch] ?? ch).join('').replace(/[^a-z0-9]/g, '');
}

export function loginBase(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  const surname = translit(parts[0]);
  const initials = parts.slice(1, 3).map(part => translit(part).slice(0, 1)).join('');
  if (!surname) return 'user';
  return initials ? `${surname}.${initials}` : surname;
}

// Уникальность — по всей таблице (UNIQUE стоит и на удалённых учётках).
export function uniqueLogin(db, fullName, exceptId = '') {
  const base = loginBase(fullName);
  const taken = db.prepare(`SELECT 1 FROM users WHERE username=? COLLATE NOCASE AND id<>?`);
  if (!taken.get(base, exceptId)) return base;
  for (let n = 2; n < 1000; n += 1) {
    if (!taken.get(`${base}${n}`, exceptId)) return `${base}${n}`;
  }
  throw new Error('Не удалось подобрать свободный логин');
}

// Логин «по образцу» (как у всех, кому доступ выдан из справочника):
// латиница фамилии, точка, инициалы, при совпадении — цифра. Прежние
// учётки прода («Тарасов Е», «Planer», «Логист 1») — не по образцу:
// при выдаче доступа такой логин заменяется стандартным (решение 11.11).
export const isStandardLogin = login => /^[a-z0-9]+(\.[a-z0-9]+)?$/.test(String(login || ''));

// Логины в настройках доступа (полный доступ к справочнику, затраты) —
// при смене логина переписываются, чтобы человек не потерял доступ.
function renameLoginInSettings(db, from, to) {
  for (const [key, field] of [['staff', 'fullAccess'], ['expenses', 'access']]) {
    const row = db.prepare('SELECT value_json FROM settings WHERE key=?').get(key);
    if (!row) continue;
    let value;
    try { value = JSON.parse(row.value_json); } catch { continue; }
    const list = String(value?.[field] || '').split(/[,;]+/).map(item => item.trim()).filter(Boolean);
    if (!list.some(item => item.toLowerCase() === String(from).toLowerCase())) continue;
    value[field] = list.map(item => item.toLowerCase() === String(from).toLowerCase() ? to : item).join(', ');
    db.prepare('UPDATE settings SET value_json=? WHERE key=?').run(JSON.stringify(value), key);
  }
}

const hasRoleSets = user => {
  try { const sets = JSON.parse(user?.role_sets || '[]'); return Array.isArray(sets) && sets.length > 0; } catch { return false; }
};

// Временный пароль: без похожих символов (0/O, 1/l/I), три группы по
// четыре — легко продиктовать и перепечатать с листка.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function generatePassword() {
  for (;;) {
    const chars = Array.from({ length: 12 }, () => ALPHABET[randomInt(ALPHABET.length)]);
    const text = chars.join('');
    if (/[a-z]/.test(text) && /[A-Z]/.test(text) && /\d/.test(text)) {
      return `${text.slice(0, 4)}-${text.slice(4, 8)}-${text.slice(8)}`;
    }
  }
}

// Правило своего пароля: не короче 10, буквы и цифры, не совпадает с
// логином и с временным.
export function passwordProblem(next, { username = '', current = '' } = {}) {
  const value = String(next || '');
  if (value.length < 10) return 'Пароль — не короче 10 символов';
  if (!/\p{L}/u.test(value) || !/\d/.test(value)) return 'В пароле нужны и буквы, и цифры';
  if (username && value.toLowerCase().includes(String(username).toLowerCase())) return 'Пароль не должен содержать логин';
  if (current && value === current) return 'Новый пароль совпадает с прежним';
  return '';
}

const today = () => new Date().toISOString().slice(0, 10);

// Гостевой доступ истёк — вход закрыт (сессии чистит проверка входа).
export function guestExpired(user, day = today()) {
  return Boolean(Number(user?.guest) && user?.guest_until && String(user.guest_until) < day);
}

export function isExternalGuest(user) {
  return Boolean(Number(user?.guest) && !user?.position_id);
}

// Выдать доступ: логин (сгенерировать, если служебный emp-…), новый
// временный пароль, обязательная смена при входе; прежние сессии гаснут.
// Повторный вызов = «сбросить пароль» (логин сохраняется).
export function issueAccess(db, userId, { hashPassword, allowAdmin = false }) {
  const user = db.prepare(`SELECT * FROM users WHERE id=? AND deleted_at IS NULL`).get(userId);
  if (!user) return { ok: false, status: 404, error: 'Сотрудник не найден' };
  if (!user.active) return { ok: false, status: 422, error: 'Сотрудник уволен — сначала восстановите' };
  const roles = rolesOf(user).filter(Boolean);
  if (!roles.length) return { ok: false, status: 422, error: 'Сначала назначьте роль — без роли вход не откроется' };
  if (roles.includes('admin') && !allowAdmin) {
    return { ok: false, status: 403, error: 'Доступ администратора выдаёт только администратор' };
  }
  if (guestExpired(user)) return { ok: false, status: 422, error: 'Срок гостевого доступа истёк — продлите' };
  const generated = !user.username || user.username.startsWith('emp-') || !isStandardLogin(user.username);
  const username = generated ? uniqueLogin(db, user.full_name, user.id) : user.username;
  const renamedFrom = generated && user.username && !user.username.startsWith('emp-') ? user.username : null;
  if (renamedFrom) renameLoginInSettings(db, renamedFrom, username);
  const password = generatePassword();
  const reissue = String(user.password_hash || '').startsWith('scrypt$');
  db.prepare(`UPDATE users SET username=?, password_hash=?, must_change_password=1,
      updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(username, hashPassword(password), user.id);
  db.prepare(`DELETE FROM sessions WHERE user_id=?`).run(user.id);
  return { ok: true, id: user.id, fullName: user.full_name, position: user.job_role || '',
    username, password, reissue, renamedFrom, guestUntil: user.guest_until || null };
}

// Массовая выдача: всем действующим с ролью, у кого входа ещё нет, и
// людям включённых отделов (есть набор ролей) с логином не по образцу —
// им стандартный логин и временный пароль, как всем (решение 11.11).
// Администраторов и отделы, ещё не включённые (без набора), не трогает.
export function issueAccessBulk(db, { hashPassword, ids = null }) {
  const rows = db.prepare(`SELECT * FROM users WHERE deleted_at IS NULL AND active=1
    ORDER BY full_name`).all()
    .filter(user => rolesOf(user).filter(Boolean).length && !rolesOf(user).includes('admin'))
    .filter(user => !String(user.password_hash || '').startsWith('scrypt$')
      || (hasRoleSets(user) && !isStandardLogin(user.username)))
    .filter(user => !ids || ids.includes(user.id))
    .filter(user => !guestExpired(user));
  return rows.map(user => issueAccess(db, user.id, { hashPassword })).filter(item => item.ok);
}

// Смена своего пароля: текущий (временный или прежний) + новый.
export function changeOwnPassword(db, user, body, { hashPassword, verifyPassword }) {
  const current = String(body?.current || '');
  const next = String(body?.next || '');
  if (!verifyPassword(current, user.password_hash)) return { ok: false, status: 422, error: 'Текущий пароль неверный' };
  const problem = passwordProblem(next, { username: user.username, current });
  if (problem) return { ok: false, status: 422, error: problem };
  db.prepare(`UPDATE users SET password_hash=?, must_change_password=0,
      password_changed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(hashPassword(next), user.id);
  return { ok: true };
}

// Гость: внешний человек, только просмотр по выбранному набору, со
// сроком. В штат и структуру не входит (нет должности).
export function createGuest(db, body, { hashPassword, allowAdmin = false, createdBy = '' }) {
  const fullName = String(body?.fullName || '').trim();
  if (!fullName) return { ok: false, status: 422, error: 'ФИО гостя обязательно' };
  const roleSet = String(body?.roleSet || '');
  if (!roleSet) return { ok: false, status: 422, error: 'Выберите, что гость видит (набор)' };
  const until = String(body?.until || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(until) || until < today()) {
    return { ok: false, status: 422, error: 'Срок доступа — дата не раньше сегодняшней' };
  }
  const note = String(body?.note || '').trim();
  const id = randomUUID();
  const username = uniqueLogin(db, fullName);
  db.prepare(`INSERT INTO users(id,username,full_name,email,password_hash,role,roles,active,guest,
      guest_until,guest_note,job_role,hired_at)
    VALUES(?,?,?,?,?,?,?,1,1,?,?,?,?)`).run(id, username, fullName, String(body?.email || '').trim() || null,
    '', '', '[]', until, note, note ? `Гость · ${note}` : 'Гость', today());
  const assigned = assignRoleSets(db, id, [roleSet], { allowAdmin: false });
  if (!assigned.ok) {
    db.prepare(`DELETE FROM users WHERE id=?`).run(id);
    return { ok: false, status: 422, error: assigned.error };
  }
  const issued = issueAccess(db, id, { hashPassword, allowAdmin });
  if (!issued.ok) {
    db.prepare(`DELETE FROM users WHERE id=?`).run(id);
    return issued;
  }
  return { ...issued, createdBy };
}

// Гость: продлить срок / сменить набор / закрыть доступ сразу.
export function updateGuest(db, id, body) {
  const user = db.prepare(`SELECT * FROM users WHERE id=? AND deleted_at IS NULL AND guest=1`).get(id);
  if (!user) return { ok: false, status: 404, error: 'Гость не найден' };
  if (body?.until !== undefined) {
    const until = String(body.until || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(until)) return { ok: false, status: 422, error: 'Срок — дата ГГГГ-ММ-ДД' };
    db.prepare(`UPDATE users SET guest_until=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(until, id);
    if (until < today()) db.prepare(`DELETE FROM sessions WHERE user_id=?`).run(id);
  }
  if (body?.roleSet) {
    const assigned = assignRoleSets(db, id, [String(body.roleSet)], { allowAdmin: false });
    if (!assigned.ok) return { ok: false, status: 422, error: assigned.error };
  }
  if (body?.note !== undefined) {
    const note = String(body.note || '').trim();
    db.prepare(`UPDATE users SET guest_note=?, job_role=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(note, note ? `Гость · ${note}` : 'Гость', id);
  }
  return { ok: true };
}
