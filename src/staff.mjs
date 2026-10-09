// Справочник сотрудников (вкладка «Сотрудники», решение руководителя
// 07.10): единое представление над users (офисные) и drivers (водители) —
// НЕ третья картотека. Карточка офисного, приём/увольнение, график смен
// произвольного заполнения (дневные/ночные). Водители остаются в своих
// моделях (вахта, отсутствия, явка) — их карточка живёт в driverCardData.

import { randomUUID } from 'node:crypto';
import { ROLE_LABELS, rolesOf, effectivePermissions } from './permissions.mjs';

// Полный доступ к справочнику: право staff:write (руководитель, админ)
// либо логин из «Настройки → Сотрудники → полный доступ» (решение 07.10:
// Никулиной — по всем, как у администратора, без выдачи роли admin).
export function staffAccess(user, settings) {
  if (!user) return false;
  if (effectivePermissions(user).includes('staff:write')) return true;
  const allowed = String(settings?.staff?.fullAccess || '')
    .split(/[,;\s]+/).map(item => item.trim().toLowerCase()).filter(Boolean);
  return allowed.includes(String(user.username || '').toLowerCase());
}

// Единый список: офисные + водители, с должностями и телефонами.
export function staffList(db) {
  const users = db.prepare(`SELECT id, username, full_name, email, role, roles, active,
      guest, phone, work_phone, ext_phone, job_role, hired_at, fired_at,
      telegram_chat_id, created_at FROM users
    WHERE deleted_at IS NULL ORDER BY active DESC, full_name`).all()
    .map(user => ({
      kind: 'user', id: user.id, fullName: user.full_name,
      jobRole: user.job_role || roleLabel(user), username: user.username,
      roles: rolesOf(user), phone: user.phone || '', extPhone: user.ext_phone || '',
      workPhone: user.work_phone || '', email: user.email || '',
      telegram: Boolean(user.telegram_chat_id), guest: Boolean(user.guest),
      active: Boolean(user.active), hiredAt: user.hired_at || user.created_at,
      firedAt: user.fired_at || null
    }));
  const drivers = db.prepare(`SELECT d.id, d.full_name, d.phone, d.status, d.vehicle_id,
      d.shift_on, d.shift_off, d.created_at, v.plate vehicle_plate FROM drivers d
    LEFT JOIN vehicles v ON v.id=d.vehicle_id
    WHERE d.status<>'fired' ORDER BY d.full_name`).all()
    .map(driver => ({
      kind: 'driver', id: driver.id, fullName: driver.full_name,
      jobRole: 'Водитель', phone: driver.phone || '',
      vehiclePlate: driver.vehicle_plate || '', status: driver.status,
      shift: driver.shift_on ? `${driver.shift_on}/${driver.shift_off}` : '',
      active: true, hiredAt: driver.created_at
    }));
  return { users, drivers };
}

function roleLabel(user) {
  const roles = rolesOf(user);
  return roles.map(role => ROLE_LABELS[role] || role).join(' + ');
}

// Карточка офисного сотрудника: данные + график месяца + история
// из журнала действий (его собственные действия и действия над ним).
export function staffUserCard(db, id, month) {
  const user = db.prepare(`SELECT id, username, full_name, email, role, roles, active,
      guest, phone, work_phone, ext_phone, job_role, hired_at, fired_at,
      telegram_chat_id, created_at FROM users WHERE id=? AND deleted_at IS NULL`).get(id);
  if (!user) return null;
  const ack = db.prepare(`SELECT MAX(acked_at) at FROM guide_acks WHERE user_id=?`).get(id)?.at || null;
  const lastLogin = db.prepare(`SELECT MAX(created_at) at FROM audit_log
    WHERE user_id=? AND action='login'`).get(id)?.at || null;
  const history = db.prepare(`SELECT created_at, action, entity, details_json FROM audit_log
    WHERE user_id=? OR (entity IN ('user','staff') AND entity_id=?)
    ORDER BY created_at DESC LIMIT 30`).all(id, id);
  return {
    user: {
      id: user.id, username: user.username, fullName: user.full_name,
      email: user.email || '', roles: rolesOf(user),
      roleLabel: roleLabel(user), jobRole: user.job_role || '',
      phone: user.phone || '', extPhone: user.ext_phone || '',
      workPhone: user.work_phone || '', telegram: Boolean(user.telegram_chat_id),
      guest: Boolean(user.guest), active: Boolean(user.active),
      hiredAt: user.hired_at || user.created_at, firedAt: user.fired_at || null,
      guideAckAt: ack, lastLoginAt: lastLogin
    },
    shifts: staffShifts(db, id, month),
    history
  };
}

// Месяц графика: {'2026-10-01':'day', ...}; пустые дни не хранятся.
// Таблица общая с переключателем «отчёта смены» (день+ночь в один день
// там допустимы) — карточка показывает один вид на день: день главнее.
export function staffShifts(db, userId, month) {
  const prefix = String(month || new Date().toISOString().slice(0, 7));
  const rows = db.prepare(`SELECT day, kind FROM staff_shifts
    WHERE user_id=? AND day LIKE ?
    ORDER BY day, CASE kind WHEN 'day' THEN 0 WHEN 'night' THEN 1 ELSE 2 END DESC`)
    .all(userId, `${prefix}-%`);
  return Object.fromEntries(rows.map(row => [row.day, row.kind]));
}

const SHIFT_KINDS = new Set(['day', 'night', 'vacation', 'sick']);

// Полная замена месяца: дни вне месяца и мусорные виды отвергаются,
// отсутствующие в payload дни месяца очищаются (пусто = выходной).
export function setStaffShifts(db, userId, month, days, editorId = null) {
  const prefix = String(month || '');
  if (!/^\d{4}-\d{2}$/.test(prefix)) return { ok: false, error: 'Месяц в формате ГГГГ-ММ' };
  const entries = Object.entries(days || {});
  for (const [day, kind] of entries) {
    if (!day.startsWith(`${prefix}-`) || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      return { ok: false, error: `День ${day} вне месяца ${prefix}` };
    }
    if (!SHIFT_KINDS.has(kind)) return { ok: false, error: `Неизвестный вид смены «${kind}»` };
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`DELETE FROM staff_shifts WHERE user_id=? AND day LIKE ?`)
      .run(userId, `${prefix}-%`);
    const insert = db.prepare(`INSERT INTO staff_shifts(id, user_id, day, kind, created_by)
      VALUES(?,?,?,?,?)`);
    for (const [day, kind] of entries) insert.run(randomUUID(), userId, day, kind, editorId);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  const counts = { day: 0, night: 0, vacation: 0, sick: 0 };
  for (const [, kind] of entries) counts[kind] += 1;
  return { ok: true, total: entries.length, counts };
}

// Увольнение офисного — ЧЕК-ЛИСТ одним действием (этап 4, 09.10):
// учётка гаснет, сессии рвутся, телефон смены и добавочный АТС
// освобождаются (карточки звонков не всплывут уволенному и сверка с
// АТС не держит номер за ним), Telegram отвязывается (боты молчат),
// будущие смены из графика снимаются. История и ФИО остаются,
// восстановление возвращает доступ.
export function fireStaffUser(db, id) {
  const user = db.prepare(`SELECT * FROM users WHERE id=? AND deleted_at IS NULL`).get(id);
  if (!user) return { ok: false, error: 'Сотрудник не найден' };
  if (rolesOf(user).includes('admin') && user.active) {
    const others = db.prepare(`SELECT COUNT(*) count FROM users, json_each(users.roles)
      WHERE json_each.value='admin' AND users.active=1 AND users.deleted_at IS NULL
        AND users.id<>?`).get(id).count;
    if (!others) return { ok: false, error: 'Должен остаться хотя бы один активный администратор' };
  }
  const cleared = {
    ext: Boolean(String(user.ext_phone || '').trim()),
    telegram: Boolean(user.telegram_chat_id)
  };
  db.prepare(`UPDATE users SET active=0, fired_at=COALESCE(fired_at, CURRENT_TIMESTAMP),
    work_phone='', ext_phone='', telegram_chat_id=NULL,
    updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(id);
  db.prepare(`DELETE FROM sessions WHERE user_id=?`).run(id);
  const today = new Date().toISOString().slice(0, 10);
  cleared.futureShifts = db.prepare(`DELETE FROM staff_shifts
    WHERE user_id=? AND day>?`).run(id, today).changes;
  return { ok: true, fullName: user.full_name, cleared };
}

export function restoreStaffUser(db, id) {
  const user = db.prepare(`SELECT * FROM users WHERE id=? AND deleted_at IS NULL`).get(id);
  if (!user) return { ok: false, error: 'Сотрудник не найден' };
  db.prepare(`UPDATE users SET active=1, fired_at=NULL, updated_at=CURRENT_TIMESTAMP
    WHERE id=?`).run(id);
  return { ok: true, fullName: user.full_name };
}

// Приём офисного из справочника. Роли admin отсюда не раздаются и
// admin-учётки отсюда не меняются — полный доступ к справочнику не
// равен администратору системы (защита от эскалации прав).
export function createStaffUser(db, body, { allowAdmin = false, hashPassword }) {
  const roles = Array.isArray(body.roles) ? [...new Set(body.roles)] : [];
  if (!roles.length || !roles.every(role => ROLE_LABELS[role])) {
    return { ok: false, error: 'Нужна хотя бы одна корректная роль' };
  }
  if (!allowAdmin && roles.includes('admin')) {
    return { ok: false, error: 'Роль «Администратор» назначает только администратор' };
  }
  const username = String(body.username || '').trim();
  const fullName = String(body.fullName || '').trim();
  if (!username || !fullName) return { ok: false, error: 'Логин и ФИО обязательны' };
  if (typeof body.password !== 'string' || body.password.length < 10) {
    return { ok: false, error: 'Пароль должен содержать не менее 10 символов' };
  }
  const taken = db.prepare(`SELECT 1 FROM users WHERE username=? COLLATE NOCASE
    AND deleted_at IS NULL`).get(username);
  if (taken) return { ok: false, error: 'Логин занят' };
  const id = randomUUID();
  db.prepare(`INSERT INTO users(id,username,full_name,email,password_hash,role,roles,active,
      phone,ext_phone,job_role,hired_at)
    VALUES(?,?,?,?,?,?,?,1,?,?,?,?)`).run(
    id, username, fullName, body.email || null, hashPassword(body.password),
    roles[0], JSON.stringify(roles),
    String(body.phone || '').trim(), String(body.extPhone || '').trim(),
    String(body.jobRole || '').trim(),
    body.hiredAt || new Date().toISOString().slice(0, 10));
  return { ok: true, id };
}

export function updateStaffUser(db, id, body, { allowAdmin = false }) {
  const user = db.prepare(`SELECT * FROM users WHERE id=? AND deleted_at IS NULL`).get(id);
  if (!user) return { ok: false, error: 'Сотрудник не найден' };
  if (!allowAdmin && rolesOf(user).includes('admin')) {
    return { ok: false, error: 'Учётку администратора меняет только администратор' };
  }
  db.prepare(`UPDATE users SET full_name=?, email=?, phone=?, ext_phone=?, job_role=?,
      hired_at=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(
    String(body.fullName ?? user.full_name).trim() || user.full_name,
    body.email ?? user.email,
    String(body.phone ?? user.phone ?? '').trim(),
    String(body.extPhone ?? user.ext_phone ?? '').trim(),
    String(body.jobRole ?? user.job_role ?? '').trim(),
    body.hiredAt ?? user.hired_at, id);
  return { ok: true };
}
