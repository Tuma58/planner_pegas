// Мост мессенджера с Битрикс24 — Э1 (13.11.2026, вебхук руководителя).
//
// Хранение: integration_connectors id='bitrix24'; token_cipher — ПОЛНЫЙ
// URL входящего вебхука (он и есть секрет), config_json: { selfId } —
// id служебного пользователя Б24, чьи сообщения мост не зеркалит обратно.
//
// Привязка: группа планера (chats) с external_source='bitrix24' и
// external_id=DIALOG_ID ('chatXXX' или числовой id собеседника).
//
// Исходящее: после записи сообщения планера в привязанной группе сервер
// зовёт mirrorToBitrix — im.message.add от служебного пользователя с
// префиксом «Имя: », наш external_id запоминается (поллинг его не вернёт).
// Входящее: pollBitrixRooms раз в минуту тянет хвост каждой привязанной
// комнаты (im.dialog.messages.get) и кладёт новое через
// receiveExternalMessage (дедуп по external_id). Исходящий вебхук Б24
// (мгновенная доставка) — этап 2; поллинг остаётся страховкой.
// Лимит портала ~2 запроса/сек: комнат единицы, раз в минуту — запас 100×.
import { receiveExternalMessage } from './messenger.mjs';

export function migrateBitrix(db) {
  db.prepare(`INSERT OR IGNORE INTO integration_connectors(id,name,base_url)
    VALUES('bitrix24','Битрикс24 (мессенджер)','https://gkpegasavto.bitrix24.ru')`).run();
}

export function bitrixConnector(db, decrypt) {
  const row = db.prepare(`SELECT token_cipher, enabled, config_json
    FROM integration_connectors WHERE id='bitrix24'`).get();
  if (!row?.enabled || !row.token_cipher) return null;
  let config = {};
  try { config = JSON.parse(row.config_json || '{}'); } catch { /* пустой */ }
  const url = decrypt(row.token_cipher);
  return url ? { url: url.replace(/\/+$/, ''), selfId: String(config.selfId || '') } : null;
}

export async function bitrixCall(connector, method, params = {}) {
  const response = await fetch(`${connector.url}/${method}.json`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params), signal: AbortSignal.timeout(15_000)
  });
  const data = await response.json().catch(() => ({}));
  if (data.error) throw new Error(`Б24 ${method}: ${data.error_description || data.error}`);
  return data.result;
}

export const linkedChats = db => db.prepare(`SELECT id, title, external_id FROM chats
  WHERE external_source='bitrix24' AND deleted_at IS NULL`).all();

// Исходящее зеркало: не валит отправку планера — мост может болеть молча,
// ошибка уходит в лог, сообщение планера живёт как жило.
export async function mirrorToBitrix(db, decrypt, { messageId, chatId, authorName, text }) {
  try {
    const connector = bitrixConnector(db, decrypt);
    if (!connector) return;
    const chat = db.prepare(`SELECT external_id FROM chats
      WHERE id=? AND external_source='bitrix24'`).get(chatId);
    if (!chat?.external_id) return;
    const result = await bitrixCall(connector, 'im.message.add', {
      DIALOG_ID: chat.external_id,
      MESSAGE: `${authorName}: ${String(text || '').slice(0, 4000)}`
    });
    if (result) db.prepare(`UPDATE messages SET external_source='bitrix24', external_id=?
      WHERE id=? AND external_id IS NULL`).run(String(result), messageId);
  } catch (error) { console.warn('мост Б24, исходящее:', error.message); }
}

// Поллинг входящих: хвост каждой привязанной комнаты, новое — в группу.
export async function pollBitrixRooms(db, decrypt) {
  const connector = bitrixConnector(db, decrypt);
  if (!connector) return { pulled: 0 };
  let pulled = 0;
  for (const chat of linkedChats(db)) {
    try {
      const result = await bitrixCall(connector, 'im.dialog.messages.get', {
        DIALOG_ID: chat.external_id, LIMIT: 20 });
      const users = new Map((result.users || []).map(u => [String(u.id), u.name]));
      // Б24 отдаёт новые первыми — вставляем старые раньше (обратный порядок).
      for (const message of (result.messages || []).reverse()) {
        if (connector.selfId && String(message.author_id) === connector.selfId) continue;
        // Системный шум («отправил приветствие», author_id=0) не мостим.
        if (String(message.author_id) === '0' || message.system === true || message.system === 'Y') continue;
        const files = (message.params?.FILES || message.files || []);
        const mediaNote = Array.isArray(files) && files.length
          ? `📎 вложение в Битрикс24 (${files.length}) — откройте там` : '';
        // BB-коды Б24 ([USER=…], [URL=…]) — в чистый текст.
        const plainText = String(message.text || '')
          .replace(/\[USER=\d+[^\]]*\]/gi, '').replace(/\[\/USER\]/gi, '')
          .replace(/\[URL=([^\]]*)\]/gi, '$1 ').replace(/\[\/URL\]/gi, '')
          .replace(/\[\/?[A-Z]+(=[^\]]*)?\]/gi, '').trim();
        const saved = receiveExternalMessage(db, {
          chatId: chat.id,
          authorName: `${users.get(String(message.author_id)) || 'Битрикс24'} (Б24)`,
          text: plainText, mediaNote,
          externalSource: 'bitrix24', externalId: message.id });
        if (saved.ok) pulled += 1;
      }
    } catch (error) { console.warn(`мост Б24, поллинг ${chat.external_id}:`, error.message); }
  }
  if (pulled) db.prepare(`UPDATE integration_connectors
    SET last_success_at=CURRENT_TIMESTAMP WHERE id='bitrix24'`).run();
  return { pulled };
}
