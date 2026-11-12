// Мессенджер (12.11.2026): отправка с ответом-цитатой, правка и мягкое
// удаление своих сообщений, границы переписок.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/db.mjs';
import { hashPassword } from '../src/security.mjs';
import * as msgModule from '../src/messenger.mjs';
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

test('мессенджер Э2–Э3: реакции, прочтение, pin/mute, видимость вложений', t => {
  const db = freshDb(t);
  const anna = addUser(db, 'u2-anna', 'Анна Р');
  const boris = addUser(db, 'u2-boris', 'Борис Р');
  const { toggleReaction, setRead, setPrefs, normRoomKey, canSeeMessage, REACTION_SET } = msgModule;
  // реакции: toggle ставит и снимает, чужая реакция живёт отдельно
  const sent = sendMessage(db, anna, { text: 'реагируйте' });
  assert.ok(toggleReaction(db, boris, sent.id, '👍').added);
  assert.ok(toggleReaction(db, anna, sent.id, '👍').added);
  assert.equal(toggleReaction(db, boris, sent.id, '👍').added, false); // снял
  const rows = db.prepare('SELECT user_id FROM message_reactions WHERE message_id=?').all(sent.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].user_id, anna.id);
  assert.ok(!toggleReaction(db, anna, sent.id, '🤡').ok); // вне набора
  assert.ok(REACTION_SET.includes('🔥'));
  assert.ok(db.prepare('SELECT reacted_at FROM messages WHERE id=?').get(sent.id).reacted_at);
  // normRoomKey: личка нормализуется одинаково с обеих сторон
  assert.equal(normRoomKey(`dm:${boris.id}`, anna.id), normRoomKey(`dm:${anna.id}`, boris.id));
  // прочтение: только вперёд
  setRead(db, boris, `dm:${anna.id}`, 10);
  setRead(db, boris, `dm:${anna.id}`, 5);
  assert.equal(db.prepare('SELECT last_read_id FROM chat_reads WHERE user_id=?')
    .get(boris.id).last_read_id, 10);
  // pin/mute: частичное обновление не затирает второй флаг
  setPrefs(db, anna, 'all', { pinned: true });
  setPrefs(db, anna, 'all', { muted: true });
  const pref = db.prepare('SELECT pinned, muted FROM chat_prefs WHERE user_id=?').get(anna.id);
  assert.equal(pref.pinned, 1);
  assert.equal(pref.muted, 1);
  // видимость: личное сообщение видят только двое
  const dm = sendMessage(db, anna, { text: 'секрет', recipientId: boris.id });
  const dmRow = db.prepare('SELECT * FROM messages WHERE id=?').get(dm.id);
  const kate = addUser(db, 'u2-kate', 'Катя Р');
  assert.ok(canSeeMessage(db, anna.id, ['logist'], dmRow));
  assert.ok(canSeeMessage(db, boris.id, ['logist'], dmRow));
  assert.ok(!canSeeMessage(db, kate.id, ['logist'], dmRow));
  // упоминание: уведомление уходит через notifyUser
  const pinged = [];
  sendMessage(db, anna, { text: 'привет @Борис_Р', mentions: [boris.id] },
    { notifyUser: name => pinged.push(name) });
  assert.deepEqual(pinged, ['Борис Р']);
});

test('мессенджер Э4: закрепление сообщений и прочитанность в группах', t => {
  const db = freshDb(t);
  const anna = addUser(db, 'u3-anna', 'Анна Т');
  const boris = addUser(db, 'u3-boris', 'Борис Т');
  const kate = addUser(db, 'u3-kate', 'Катя Т');
  const { togglePin, setRead, roomReads } = msgModule;
  // pin: toggle любой видящий; откреп ставит штамп синка
  const sent = sendMessage(db, anna, { text: 'важное' });
  assert.equal(togglePin(db, boris, sent.id).pinned, true);
  let row = db.prepare('SELECT pinned_at, pinned_by_name FROM messages WHERE id=?').get(sent.id);
  assert.ok(row.pinned_at);
  assert.equal(row.pinned_by_name, 'Борис Т');
  assert.equal(togglePin(db, anna, sent.id).pinned, false);
  row = db.prepare('SELECT pinned_at, reacted_at FROM messages WHERE id=?').get(sent.id);
  assert.equal(row.pinned_at, null);
  assert.ok(row.reacted_at); // откреп доедет до вкладок через since
  // прочитанность общего канала: Борис дочитал, Катя нет
  setRead(db, boris, 'all', sent.id);
  setRead(db, kate, 'all', sent.id - 1);
  const reads = roomReads(db, 'all', anna.id);
  const readBoris = reads.find(item => item.name === 'Борис Т');
  const readKate = reads.find(item => item.name === 'Катя Т');
  assert.ok(readBoris && readBoris.lastReadId >= sent.id);
  assert.ok(readKate && readKate.lastReadId < sent.id);
  assert.ok(!reads.some(item => item.name === 'Анна Т')); // сам автор не в списке
});
