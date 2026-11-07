export const ROLE_LABELS = {
  admin: 'Администратор',
  logist: 'Логист',
  // Подписи ролей по структуре СТ (решение руководителя 05.11); коды
  // прежние — на них права, адресаты уведомлений и отметки задач.
  resource: 'Эксплуатация (учёт)',
  dispatcher: 'Диспетчер-логист (контроль)',
  sales: 'Планирование',
  accountant: 'Бухгалтерия',
  manager: 'Руководитель',
  mechanic: 'Механик',
  // Охранник-парковщик (журнал КПП стоянки, 07.11): пост на базе в Пензе.
  guard: 'Охранник-парковщик',
  // Контролёр техсостояния (экран «Выпуск», 07.11): техконтроль перед
  // выпуском, «В ремонт» при неисправности.
  techctl: 'Контролёр техсостояния'
};

const ALL = [
  'planner:read', 'trips:write', 'trip-status:write', 'orders:write',
  'fleet:write', 'payments:write', 'reports:read', 'customers:read',
  'settings:write', 'users:write', 'integration:write', 'audit:read',
  'shifts:write', 'staff:write', 'expenses:write', 'gate:write', 'release:write'
];

export const ROLE_PERMISSIONS = {
  admin: ALL,
  logist: ['planner:read', 'trips:write', 'orders:read', 'customers:read'],
  resource: ['planner:read', 'fleet:write', 'customers:read', 'release:write'],
  dispatcher: ['planner:read', 'trip-status:write', 'customers:read'],
  sales: ['planner:read', 'orders:write', 'customers:read'],
  // Учёт затрат: доступ ПЕРСОНАЛЬНЫЙ (решение 03.11 «пока только у
  // меня») — право expenses:write лишь у admin (через ALL), остальных
  // впускает список логинов в настройке (expensesAccess, expenses.mjs).
  accountant: ['planner:read', 'payments:write', 'customers:read'],
  // График смен сотрудников ведёт руководитель (и админ через ALL).
  // staff:write — справочник сотрудников («Сотрудники»): карточки,
  // приём/увольнение, графики смен (решение руководителя 07.10).
  manager: ['planner:read', 'reports:read', 'customers:read', 'shifts:write', 'staff:write'],
  // Механик (блок «Ремзона», старт 14.09.2026): видит парк и ведёт
  // недоступности — заезды в ремонт/ТО, их причины и закрытие.
  mechanic: ['planner:read', 'fleet:write'],
  // КПП (07.11): въезд/выезд в журнале — факт рейса НЕ ставит, только
  // подсказывает диспетчеру (решение руководителя).
  guard: ['gate:write'],
  // «Выпуск» (П2, 07.11): отметка техконтроля в путевой лист и «В ремонт».
  techctl: ['release:write']
};

export function permissionsFor(role) {
  return ROLE_PERMISSIONS[role] || [];
}

// Роли пользователя: JSON-массив в user.roles (мульти-роли) с фолбэком на user.role.
export function rolesOf(user) {
  if (user?.roles) {
    try {
      const parsed = Array.isArray(user.roles) ? user.roles : JSON.parse(user.roles);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    } catch { /* некорректный JSON — используем одиночную роль */ }
  }
  return user?.role ? [user.role] : [];
}

// Объединение прав всех ролей пользователя.
export function permissionsForRoles(roles) {
  return [...new Set(roles.flatMap(role => permissionsFor(role)))];
}

export function roleLabelsFor(roles) {
  return roles.map(role => ROLE_LABELS[role] || role).join(' + ');
}

// Гостевой режим (users.guest): сотрудник видит всё по своим ролям, но любые
// права на запись отсекаются — остаются только «…:read». Включает админ.
export function effectivePermissions(user) {
  const all = permissionsForRoles(rolesOf(user));
  return Number(user?.guest) ? all.filter(permission => permission.endsWith(':read')) : all;
}

export function hasPermission(user, permission) {
  return Boolean(user?.active && effectivePermissions(user).includes(permission));
}
