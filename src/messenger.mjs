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
    reply = db.prepare(`SELECT id, recipient_id, chat_id, author_id, kind, target_role FROM messages
      WHERE id=? AND deleted_at IS NULL`).get(Number(replyToId));
    // Ответ живёт строго в той же переписке, что и оригинал (аудит OWASP
    // 14.11): прежняя проверка пускала ответ на ЧУЖУЮ личку адресата
    // (B↔C), и цитата в 120 символов уезжала в переписку A↔B. Ошибка одна
    // на «нет» и «чужое» — существование сообщения не подсказываем.
    if (!reply || !sameReplyRoom(reply, user.id, { chatId, recipientId })) {
      return { ok: false, status: 422, error: 'Ответ должен быть в той же переписке' };
    }
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

// Та же ли переписка у ответа и оригинала: группа — тот же chat_id
// (членство отправителя сервер проверяет на входе); личка — ровно пара
// {я, собеседник}; общий канал — только общедоступные сообщения (личные,
// групповые и адресованные роли уведомления в общий не цитируются).
export function sameReplyRoom(reply, userId, { chatId = null, recipientId = null } = {}) {
  const me = String(userId);
  if (chatId) return String(reply.chat_id || '') === String(chatId);
  if (reply.chat_id) return false;
  if (recipientId) {
    const peer = String(recipientId);
    const author = String(reply.author_id ?? '');
    const target = String(reply.recipient_id ?? '');
    return (author === me && target === peer) || (author === peer && target === me);
  }
  if (reply.recipient_id) return false;
  return !(reply.kind === 'auto' && reply.target_role);
}

// Набор реакций — осознанно короткий (как в Битрикс24): шесть смыслов
// хватает, зоопарк эмодзи превращает ленту в шум.
export const REACTION_SET = ['👍', '❤️', '😂', '😮', '😢', '🔥'];

// Входящее сообщение внешнего мессенджера (мост Б24, Э1 13.11): пишется
// в привязанную группу от имени внешнего автора, дедуп по external_id —
// поллинг и вебхук могут принести одно и то же сообщение дважды.
export function receiveExternalMessage(db, { chatId, authorName, text, mediaNote = '',
  externalSource, externalId }) {
  if (!chatId || !externalSource || !externalId) return { ok: false, error: 'нет привязки' };
  const seen = db.prepare(`SELECT 1 FROM messages
    WHERE external_source=? AND external_id=? LIMIT 1`).get(externalSource, String(externalId));
  if (seen) return { ok: false, duplicate: true };
  const clean = `${String(text || '').trim()}${mediaNote ? `${text ? '\n' : ''}${mediaNote}` : ''}`
    .slice(0, 500);
  if (!clean) return { ok: false, error: 'пусто' };
  const info = db.prepare(`INSERT INTO messages(author_name,kind,text,chat_id,
      external_source,external_id)
    VALUES(?,'user',?,?,?,?)`).run(
    String(authorName || 'Битрикс24').slice(0, 80), clean, chatId,
    externalSource, String(externalId));
  return { ok: true, id: Number(info.lastInsertRowid) };
}

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

// Закрепить/открепить сообщение в переписке (Э4): может любой, кому
// переписка видна (как в Битрикс24). Штамп reacted_at — для синка
// открытых вкладок (откреп иначе не доехал бы: pinned_at становится NULL).
export function togglePin(db, user, messageId) {
  const message = db.prepare(`SELECT * FROM messages WHERE id=?`).get(Number(messageId));
  if (!message || message.deleted_at) return { ok: false, status: 404, error: 'Сообщение не найдено' };
  if (message.kind !== 'user') return { ok: false, status: 422, error: 'Закрепляются только сообщения людей' };
  const pin = !message.pinned_at;
  db.prepare(`UPDATE messages SET pinned_at=?, pinned_by_name=?, reacted_at=CURRENT_TIMESTAMP
    WHERE id=?`).run(pin ? new Date().toISOString() : null,
    pin ? (user.full_name || user.username) : null, message.id);
  return { ok: true, pinned: pin };
}

// Прочитанность в группах (Э4): кто из участников дочитал докуда — для
// «✓✓ N» у своих сообщений. Для общего канала участники = все активные.
export function roomReads(db, roomKey, userId) {
  const norm = normRoomKey(roomKey, userId);
  let members;
  if (roomKey.startsWith('group:')) {
    members = db.prepare(`SELECT u.id, u.full_name name FROM chat_members m
      JOIN users u ON u.id=m.user_id WHERE m.chat_id=?`).all(roomKey.slice(6));
  } else if (roomKey === 'all') {
    members = db.prepare(`SELECT id, full_name name FROM users
      WHERE active=1 AND deleted_at IS NULL`).all();
  } else return [];
  const reads = new Map(db.prepare(`SELECT user_id, last_read_id FROM chat_reads
    WHERE room_key=?`).all(norm).map(row => [row.user_id, row.last_read_id]));
  return members.filter(member => member.id !== userId && reads.has(member.id))
    .map(member => ({ name: member.name, lastReadId: reads.get(member.id) }))
    .slice(0, 100);
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
