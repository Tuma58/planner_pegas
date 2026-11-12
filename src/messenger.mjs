// Мессенджер планера (12.11.2026): операции над сообщениями одним модулем.
// Это ЕДИНАЯ ТОЧКА записи — сюда же встанет мост во внешние мессенджеры.
//
// Карта соответствий с Битрикс24 (фундамент интеграции, изучено 12.11):
//   наш roomKey 'dm:<userId>'   ↔ Б24 DIALOG_ID = <числовой id пользователя>
//   наш roomKey 'group:<chatId>'↔ Б24 DIALOG_ID = 'chatXXX'
//   наша лента 'role:<код>'     ↔ аналога нет (широковещание планера)
//   messages.external_source/external_id — id сообщения там ('bitrix24'),
//   chats.external_source/external_id — чат там; мост: исходящее — после
//   INSERT дернуть im.message.add и сохранить external_id; входящее —
//   вебхук Б24 кладёт сообщение с external_* (дедуп по ним).

// Сколько времени автор может править/удалять своё сообщение (как в
// телеграме — ограничено, чтобы история переписки оставалась историей).
export const EDIT_WINDOW_MS = 48 * 3_600_000;

export function sendMessage(db, user, { text, recipientId = null, chatId = null,
  replyToId = null, externalSource = null, externalId = null }) {
  const clean = String(text || '').trim().slice(0, 500);
  if (!clean) return { ok: false, status: 422, error: 'Пустое сообщение' };
  let reply = null;
  if (replyToId) {
    reply = db.prepare(`SELECT id, recipient_id, chat_id, author_id FROM messages
      WHERE id=? AND deleted_at IS NULL`).get(Number(replyToId));
    if (!reply) return { ok: false, status: 422, error: 'Сообщение, на которое отвечаете, не найдено' };
    // Ответ живёт в той же переписке, что и оригинал — подмена адресата
    // ответом недопустима (личное не утечёт в общий и наоборот).
    const sameRoom = (reply.chat_id || null) === (chatId || null)
      && ((reply.recipient_id || null) === (recipientId || null)
        || reply.author_id === recipientId
        || (reply.recipient_id === user.id && reply.author_id === (recipientId || null)));
    if (!sameRoom) return { ok: false, status: 422, error: 'Ответ должен быть в той же переписке' };
  }
  const info = db.prepare(`INSERT INTO messages(author_id,author_name,kind,text,recipient_id,
      chat_id,reply_to_id,external_source,external_id)
    VALUES(?,?,'user',?,?,?,?,?,?)`).run(
    user.id, user.full_name || user.username, clean, recipientId, chatId,
    reply ? reply.id : null, externalSource, externalId);
  return { ok: true, id: Number(info.lastInsertRowid) };
}

export function editMessage(db, user, messageId, text) {
  const clean = String(text || '').trim().slice(0, 500);
  if (!clean) return { ok: false, status: 422, error: 'Пустое сообщение' };
  const message = db.prepare(`SELECT id, author_id, kind, created_at, deleted_at
    FROM messages WHERE id=?`).get(Number(messageId));
  if (!message || message.deleted_at) return { ok: false, status: 404, error: 'Сообщение не найдено' };
  if (message.kind !== 'user' || message.author_id !== user.id) {
    return { ok: false, status: 403, error: 'Править можно только свои сообщения' };
  }
  if (Date.now() - Date.parse(message.created_at.replace(' ', 'T') + 'Z') > EDIT_WINDOW_MS) {
    return { ok: false, status: 422, error: 'Правка доступна 48 часов после отправки' };
  }
  db.prepare(`UPDATE messages SET text=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(clean, message.id);
  return { ok: true };
}

export function deleteMessage(db, user, messageId, { isAdmin = false } = {}) {
  const message = db.prepare(`SELECT id, author_id, kind, created_at, deleted_at
    FROM messages WHERE id=?`).get(Number(messageId));
  if (!message || message.deleted_at) return { ok: false, status: 404, error: 'Сообщение не найдено' };
  const own = message.kind === 'user' && message.author_id === user.id;
  if (!own && !isAdmin) return { ok: false, status: 403, error: 'Удалять можно только свои сообщения' };
  if (own && !isAdmin && Date.now() - Date.parse(message.created_at.replace(' ', 'T') + 'Z') > EDIT_WINDOW_MS) {
    return { ok: false, status: 422, error: 'Удаление доступно 48 часов после отправки' };
  }
  // Мягкое удаление: текст затирается сразу (не хранить удалённое),
  // строка остаётся, чтобы лента и ответы-цитаты не ломались.
  db.prepare(`UPDATE messages SET text='', deleted_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(message.id);
  return { ok: true };
}
