// Экспорт учётных записей пользователей в JSON (stdout).
// Запускается внутри контейнера: docker compose exec -T planner node scripts/export-users.mjs > users.json
// Путь к БД берётся из DATABASE_PATH (в контейнере /app/data/planner.db).
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const dbPath = process.env.DATABASE_PATH || path.resolve(import.meta.dirname, '..', 'data/planner.db');
const db = new DatabaseSync(dbPath, { readOnly: true });
const users = db.prepare(
  'SELECT id,username,full_name,email,password_hash,role,roles,active FROM users ORDER BY created_at'
).all();
db.close();
process.stdout.write(JSON.stringify(users, null, 2));
