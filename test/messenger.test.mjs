// Мессенджер (12.11.2026): отправка с ответом-цитатой, правка и мягкое
// удаление своих сообщений, границы переписок.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/db.mjs';
import { hashPassword } from '../src/security.mjs';
import { deleteMessage, editMessage, sendMessage } from '../src/messenger.mjs';
import { chatMessages } from '../src/planner-service.mjs';

function freshDb(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pegas-msg-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = openDatabase(path.join(directory, 'planner.db'), {
    username: 'root-admin', password: 'Temporary-password-2026', fullName: 'Администратор'
  });
  t.after(() => db.close());
  return db;
}
const addUser = (db, id, name) => {
  db.prepare(`INSERT INTO users(id, username, full_name, password_hash, role, roles, active)
    VALUES(?, ?, ?, ?, 'logist', '["logist"]', 1)`).run(id, id, name, hashPassword('Secret-pass-123'));
  return { id, full_name: name, username: id };
};

test('мессенджер: ответ-цитата живёт в своей переписке, правка и удаление — только свои и 48 ч', t => {
  const db = freshDb(t);
  const anna = addUser(db, 'u-anna', 'Анна');
  const boris = addUser(db, 'u-boris', 'Борис');

  // Общий канал: сообщение + ответ на него.
  const first = sendMessage(db, anna, { text: 'Всем привет' });
  assert.ok(first.ok);
  const reply = sendMessage(db, boris, { text: 'И вам', replyToId: first.id });
  assert.ok(reply.ok);
  const feed = chatMessages(db, boris.id, ['logist']).items;
  const replyRow = feed.find(item => item.id === reply.id);
  assert.equal(replyRow.reply_to_id, first.id);
  assert.equal(replyRow.reply_author, 'Анна');
  assert.match(replyRow.reply_text, /Всем привет/);

  // Ответ на личное сообщение из общего канала — отклоняется (чужая переписка).
  const dm = sendMessage(db, anna, { text: 'лично Борису', recipientId: boris.id });
  const cross = sendMessage(db, boris, { text: 'в общий с цитатой лички', replyToId: dm.id });
  assert.ok(!cross.ok);

  // Правка: только автор.
  assert.ok(!editMessage(db, boris, first.id, 'взлом').ok);
  assert.ok(editMessage(db, anna, first.id, 'Всем привет (поправлено)').ok);
  const edited = db.prepare('SELECT text, updated_at FROM messages WHERE id=?').get(first.id);
  assert.match(edited.text, /поправлено/);
  assert.ok(edited.updated_at);

  // Старше 48 часов — не правится и не удаляется автором.
  db.prepare(`UPDATE messages SET created_at=datetime('now','-3 days') WHERE id=?`).run(first.id);
  assert.ok(!editMessage(db, anna, first.id, 'поздно').ok);
  assert.ok(!deleteMessage(db, anna, first.id).ok);
  // Администратор удаляет без окна.
  assert.ok(deleteMessage(db, anna, first.id, { isAdmin: true }).ok);
  const deleted = db.prepare('SELECT text, deleted_at FROM messages WHERE id=?').get(first.id);
  assert.equal(deleted.text, '');
  assert.ok(deleted.deleted_at);
  // Лента отдаёт удалённое пузырём-заглушкой, цитата на него — пустая.
  const after = chatMessages(db, boris.id, ['logist']).items;
  assert.equal(after.find(item => item.id === first.id).text, '');
  assert.equal(after.find(item => item.id === reply.id).reply_text, '');

  // Удаление чужого обычным пользователем — отказ.
  const borisMsg = sendMessage(db, boris, { text: 'моё' });
  assert.ok(!deleteMessage(db, anna, borisMsg.id).ok);
});
