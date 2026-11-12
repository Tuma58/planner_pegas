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
  replyToId = null, mediaId = null, mediaMime = null, mediaName = null,
  mentions = [], externalSource = null, externalId = null }, { notifyUser } = {}) {
  const clean = String(text || '').trim().slice(0, 500);
  if (!clean && !mediaId) return { ok: false, status: 422, error: 'Пустое сообщение' };
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
      chat_id,reply_to_id,media_id,media_mime,media_name,external_source,external_id)
    VALUES(?,?,'user',?,?,?,?,?,?,?,?,?)`).run(
    user.id, user.full_name || user.username, clean, recipientId, chatId,
    reply ? reply.id : null, mediaId, mediaMime, mediaName, externalSource, externalId);
  const id = Number(info.lastInsertRowid);
  // @упоминания (Э2): каждому упомянутому — личная строка в «📬 Планер —
  // лично» и внешние каналы через notifyUser (его даёт сервер).
  const mentionIds = [...new Set((mentions || []).map(String))]
    .filter(uid => uid && uid !== user.id).slice(0, 20);
  for (const uid of mentionIds) {
    const mentioned = db.prepare(`SELECT id, full_name FROM users
      WHERE id=? AND active=1 AND deleted_at IS NULL`).get(uid);
    if (!mentioned) continue;
    const where = chatId ? 'в группе' : recipientId ? 'в личной переписке' : 'в общем чате';
    notifyUser?.(mentioned.full_name,
      `💬 ${user.full_name || user.username} упомянул вас ${where}: ${clean.slice(0, 160)}`);
  }
  return { ok: true, id };
}

// Набор реакций — осознанно короткий (как в Битрикс24): шесть смыслов
// хватает, зоопарк эмодзи превращает ленту в шум.
export const REACTION_SET = ['👍', '❤️', '😂', '😮', '😢', '🔥'];

export function toggleReaction(db, user, messageId, emoji) {
  if (!REACTION_SET.includes(emoji)) return { ok: false, status: 422, error: 'Неизвестная реакция' };
  const message = db.prepare(`SELECT id, deleted_at FROM messages WHERE id=?`).get(Number(messageId));
  if (!message || message.deleted_at) return { ok: false, status: 404, error: 'Сообщение не найдено' };
  const existing = db.prepare(`SELECT 1 FROM message_reactions
    WHERE message_id=? AND user_id=? AND emoji=?`).get(message.id, user.id, emoji);
  if (existing) {
    db.prepare(`DELETE FROM message_reactions WHERE message_id=? AND user_id=? AND emoji=?`)
      .run(message.id, user.id, emoji);
  } else {
    db.prepare(`INSERT INTO message_reactions(message_id,user_id,user_name,emoji)
      VALUES(?,?,?,?)`).run(message.id, user.id, user.full_name || user.username, emoji);
  }
  // Штамп реакции — по нему открытые вкладки коллег дотянут изменение
  // (since-механизм); updated_at не трогаем, чтобы не рисовать «изм.».
  db.prepare(`UPDATE messages SET reacted_at=CURRENT_TIMESTAMP WHERE id=?`).run(message.id);
  return { ok: true, added: !existing };
}

// Нормализованный ключ переписки для серверных таблиц (reads/prefs):
// личка у каждого из двоих называется по-своему (dm:<peerId>) — на
// сервере она одна: dm:<меньший id>:<больший id>.
export function normRoomKey(roomKey, userId) {
  const key = String(roomKey || '');
  if (key.startsWith('dm:')) {
    const pair = [key.slice(3), String(userId)].sort();
    return `dm:${pair[0]}:${pair[1]}`;
  }
  return key.slice(0, 80);
}

export function setRead(db, user, roomKey, lastReadId) {
  const norm = normRoomKey(roomKey, user.id);
  if (!norm) return { ok: false, status: 422, error: 'Нет переписки' };
  db.prepare(`INSERT INTO chat_reads(user_id,room_key,last_read_id)
    VALUES(?,?,?) ON CONFLICT(user_id,room_key) DO UPDATE SET
      last_read_id=MAX(last_read_id, excluded.last_read_id), updated_at=CURRENT_TIMESTAMP`)
    .run(user.id, norm, Math.max(0, Number(lastReadId) || 0));
  return { ok: true };
}

export function setPrefs(db, user, roomKey, { pinned, muted }) {
  const norm = normRoomKey(roomKey, user.id);
  if (!norm) return { ok: false, status: 422, error: 'Нет переписки' };
  const current = db.prepare(`SELECT pinned, muted FROM chat_prefs
    WHERE user_id=? AND room_key=?`).get(user.id, norm) || { pinned: 0, muted: 0 };
  db.prepare(`INSERT INTO chat_prefs(user_id,room_key,pinned,muted)
    VALUES(?,?,?,?) ON CONFLICT(user_id,room_key) DO UPDATE SET
      pinned=excluded.pinned, muted=excluded.muted, updated_at=CURRENT_TIMESTAMP`)
    .run(user.id, norm,
      pinned === undefined ? current.pinned : (pinned ? 1 : 0),
      muted === undefined ? current.muted : (muted ? 1 : 0));
  return { ok: true };
}

// Видно ли сообщение пользователю — та же логика, что у выдачи ленты
// (отдача вложений проверяет адресность: личный файл чужому не уйдёт).
export function canSeeMessage(db, userId, userRoles, message) {
  if (!message) return false;
  if (message.chat_id) {
    return Boolean(db.prepare(`SELECT 1 FROM chat_members m
      JOIN chats c ON c.id=m.chat_id AND c.deleted_at IS NULL
      WHERE m.chat_id=? AND m.user_id=?`).get(message.chat_id, userId));
  }
  if (message.recipient_id) {
    return message.recipient_id === userId || message.author_id === userId;
  }
  if (message.kind === 'auto') {
    return !message.target_role || (userRoles || []).includes(message.target_role);
  }
  return true; // общий канал
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
