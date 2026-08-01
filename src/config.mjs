import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(import.meta.dirname, '..');
const booleanEnv = (name, fallback) => {
  const value = process.env[name];
  if (value === undefined) return fallback;
  if (['true', '1', 'yes'].includes(value.toLowerCase())) return true;
  if (['false', '0', 'no'].includes(value.toLowerCase())) return false;
  throw new Error(`${name} должен быть true или false`);
};
const secret = (name, fallback) => {
  const file = process.env[`${name}_FILE`];
  if (file) return fs.readFileSync(file, 'utf8').trim();
  return process.env[name] || fallback;
};

export const config = {
  root,
  host: process.env.HOST || '127.0.0.1',
  port: Number(process.env.PORT || 3000),
  databasePath: path.resolve(root, process.env.DATABASE_PATH || 'data/planner.db'),
  publicPath: path.join(root, 'public'),
  sessionTtlMs: Number(process.env.SESSION_TTL_HOURS || 12) * 3_600_000,
  appSecret: secret('APP_SECRET', 'development-only-secret-change-before-production'),
  isProduction: process.env.NODE_ENV === 'production',
  secureCookies: booleanEnv('COOKIE_SECURE', process.env.NODE_ENV === 'production'),
  // За reverse-proxy (nginx → опубликованный порт Docker) соединение приходит с адреса
  // docker-шлюза, а не с 127.0.0.1, поэтому X-Forwarded-Proto/X-Real-IP нужно доверять явно.
  // Порт приложения слушает только nginx, поэтому подделать заголовки может лишь он.
  trustProxy: booleanEnv('TRUST_PROXY', process.env.NODE_ENV === 'production'),
  embeddedSyncWorker: process.env.SYNC_WORKER_EMBEDDED !== 'false',
  initialAllowedSubnets: String(process.env.INITIAL_ALLOWED_SUBNETS || '0.0.0.0/0,::/0')
    .split(',').map(item => item.trim()).filter(Boolean),
  admin: {
    username: process.env.ADMIN_USERNAME || 'admin',
    password: secret('ADMIN_PASSWORD', 'ChangeMe-2026!'),
    fullName: process.env.ADMIN_NAME || 'Администратор'
  }
};

if (config.isProduction && (config.appSecret.startsWith('development-') || config.appSecret.length < 32)) {
  throw new Error('Для production необходимо задать APP_SECRET длиной не менее 32 символов');
}
