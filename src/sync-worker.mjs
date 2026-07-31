import { config } from './config.mjs';
import { openDatabase } from './db.mjs';
import { startIntegrationScheduler } from './odata.mjs';

const db = openDatabase(config.databasePath, config.admin);
startIntegrationScheduler(db, config.appSecret);
console.log('Служба обмена 1С запущена');

function shutdown() {
  db.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
setInterval(() => {}, 2_147_000_000);
