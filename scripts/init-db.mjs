import { config } from '../src/config.mjs';
import { openDatabase } from '../src/db.mjs';

const db = openDatabase(config.databasePath, config.admin);
const result = db.prepare('SELECT COUNT(*) AS count FROM users').get();
db.close();
console.log(`База готова: ${config.databasePath}; пользователей: ${result.count}`);
