export const ROLE_LABELS = {
  admin: 'Администратор',
  logist: 'Логист',
  resource: 'Ресурс',
  dispatcher: 'Диспетчер',
  sales: 'Отдел продаж',
  accountant: 'Бухгалтерия',
  manager: 'Руководитель'
};

const ALL = [
  'planner:read', 'trips:write', 'trip-status:write', 'orders:write',
  'fleet:write', 'payments:write', 'reports:read', 'customers:read',
  'settings:write', 'users:write', 'integration:write', 'audit:read'
];

export const ROLE_PERMISSIONS = {
  admin: ALL,
  logist: ['planner:read', 'trips:write', 'orders:read', 'customers:read'],
  resource: ['planner:read', 'fleet:write', 'customers:read'],
  dispatcher: ['planner:read', 'trip-status:write', 'customers:read'],
  sales: ['planner:read', 'orders:write', 'customers:read'],
  accountant: ['planner:read', 'payments:write', 'customers:read'],
  manager: ['planner:read', 'reports:read', 'customers:read']
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
