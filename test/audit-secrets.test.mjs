// Аудит OWASP 14.11: секреты интеграций не живут в журнале аудита.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { audit, openDatabase, scrubAuditSecrets } from '../src/db.mjs';
import { SECRET_MARK, redactSecrets } from '../src/security.mjs';

function freshDb(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pegas-audit-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = openDatabase(path.join(directory, 'planner.db'), {
    username: 'root-admin', password: 'Temporary-password-2026', fullName: 'Администратор'
  });
  t.after(() => db.close());
  return db;
}

test('redactSecrets: секреты скрыты на любой глубине, признаки и обычные поля целы', () => {
  const clean = redactSecrets({
    bitrix24: { webhookUrl: 'https://x.bitrix24.ru/rest/1/abc/', enabled: true },
    telematics: { token: 'tok-123', baseUrl: 'https://t.example' },
    rncard: { login: 'ivan', password: 'p@ss' },
    telephony: { hasToken: true, apiKey: 'k' },
    list: [{ secret: 's' }], empty: { token: '' }, note: 'обычный текст'
  });
  assert.equal(clean.bitrix24.webhookUrl, SECRET_MARK);
  assert.equal(clean.bitrix24.enabled, true);
  assert.equal(clean.telematics.token, SECRET_MARK);
  assert.equal(clean.telematics.baseUrl, 'https://t.example');
  assert.equal(clean.rncard.password, SECRET_MARK);
  assert.equal(clean.rncard.login, 'ivan');
  assert.equal(clean.telephony.hasToken, true);
  assert.equal(clean.telephony.apiKey, SECRET_MARK);
  assert.equal(clean.list[0].secret, SECRET_MARK);
  assert.equal(clean.empty.token, '', 'пустое значение не маскируется');
  assert.equal(clean.note, 'обычный текст');
});

test('audit() пишет без секретов; разовая чистка вычищает старые строки и идемпотентна', t => {
  const db = freshDb(t);
  audit(db, null, 'update', 'integration', '1', { telematics: { token: 'live-token' } });
  const fresh = db.prepare(`SELECT details_json FROM audit_log WHERE entity='integration'`).get();
  assert.ok(!fresh.details_json.includes('live-token'));
  // Старая строка «до исправления» — прямой вставкой.
  db.prepare(`INSERT INTO audit_log(id,user_id,action,entity,entity_id,details_json,ip)
    VALUES('old-1',NULL,'update','integration','1',?, '')`)
    .run(JSON.stringify({ bitrix24: { webhookUrl: 'https://x/rest/1/secret/' }, rncard: { password: 'p1' } }));
  db.prepare(`DELETE FROM app_meta WHERE key='audit_secrets_scrub_v1'`).run();
  assert.equal(scrubAuditSecrets(db), 1);
  const old = db.prepare(`SELECT details_json FROM audit_log WHERE id='old-1'`).get().details_json;
  assert.ok(!old.includes('secret/') && !old.includes('p1'));
  assert.equal(scrubAuditSecrets(db), 0, 'повторный запуск ничего не трогает');
});
