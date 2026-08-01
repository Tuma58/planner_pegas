// Импорт учётных записей пользователей из JSON (файл-аргумент или stdin) с UPSERT по username.
// password_hash переносится как есть (пароли не меняются). Запускается внутри контейнера:
//   docker compose exec -T planner node scripts/import-users.mjs < users.json
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const dbPath = process.env.DATABASE_PATH || path.resolve(import.meta.dirname, '..', 'data/planner.db');
const source = process.argv[2];
const raw = source ? fs.readFileSync(source, 'utf8') : fs.readFileSync(0, 'utf8');
const users = JSON.parse(raw);
if (!Array.isArray(users)) {
  throw new Error('Ожидается JSON-массив пользователей');
}

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA busy_timeout=5000');
const upsert = db.prepare(`INSERT INTO users(id,username,full_name,email,password_hash,role,active)
  VALUES(?,?,?,?,?,?,?)
  ON CONFLICT(username) DO UPDATE SET
    full_name=excluded.full_name, email=excluded.email,
    password_hash=excluded.password_hash, role=excluded.role,
    active=excluded.active, updated_at=CURRENT_TIMESTAMP`);

let imported = 0;
let skipped = 0;
db.exec('BEGIN IMMEDIATE');
try {
  for (const user of users) {
    if (!user || !user.username || !user.password_hash || !user.role) {
      skipped++;
      continue;
    }
    upsert.run(
      user.id || randomUUID(),
      user.username,
      user.full_name || user.username,
      user.email ?? null,
      user.password_hash,
      user.role,
      user.active === 0 ? 0 : 1
    );
    imported++;
  }
  db.exec('COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  throw error;
}
db.close();
console.log(`Импортировано пользователей: ${imported}${skipped ? `, пропущено некорректных: ${skipped}` : ''}`);
