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

export function hasPermission(user, permission) {
  return Boolean(user?.active && permissionsFor(user.role).includes(permission));
}
