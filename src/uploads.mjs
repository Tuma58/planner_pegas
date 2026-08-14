// Файлы, прикреплённые к потребности клиента (заявке): лимиты и типы.
// Содержимое лежит на диске рядом с БД (data/uploads — на проде это
// проброшенный том, переживает пересборку контейнера), метаданные —
// в таблице order_files.
import path from 'node:path';
import { config } from './config.mjs';

export const uploadsPath = path.join(path.dirname(config.databasePath), 'uploads');
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
export const MAX_FILES_PER_ORDER = 10;

// Разрешённые расширения → MIME. Клиентскому Content-Type не доверяем:
// тип определяется только по расширению из этого словаря, поэтому отдать
// HTML/скрипт под видом файла заявки нельзя.
const UPLOAD_TYPES = {
  '.pdf': 'application/pdf',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.heic': 'image/heic', '.gif': 'image/gif',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.csv': 'text/csv', '.txt': 'text/plain', '.rtf': 'application/rtf',
  '.zip': 'application/zip'
};

// Эти типы браузер показывает, не исполняя разметку, — можно открывать
// во вкладке (inline); остальные отдаются только на скачивание.
export const INLINE_TYPES = new Set([
  'application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/gif'
]);

export function uploadMimeOf(fileName) {
  const ext = path.extname(String(fileName || '').toLowerCase());
  return UPLOAD_TYPES[ext] || null;
}

// Имя файла из заголовка: без путей и управляющих символов; длинное имя
// режется с сохранением расширения в хвосте.
export function cleanFileName(raw) {
  const base = String(raw || '').split(/[\\/]/).pop()
    .replace(/[\u0000-\u001f"<>|?*]/g, '').trim();
  if (base.length <= 120) return base;
  return `${base.slice(0, 80)}…${base.slice(-36)}`;
}
