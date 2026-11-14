import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual
} from 'node:crypto';

const b64u = value => Buffer.from(value).toString('base64url');

export function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 10) {
    throw new Error('Пароль должен содержать не менее 10 символов');
  }
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt$${b64u(salt)}$${b64u(hash)}`;
}

export function verifyPassword(password, stored) {
  try {
    const [scheme, salt, expected] = stored.split('$');
    if (scheme !== 'scrypt') return false;
    const actual = scryptSync(password, Buffer.from(salt, 'base64url'), 64);
    const expectedBuffer = Buffer.from(expected, 'base64url');
    return actual.length === expectedBuffer.length && timingSafeEqual(actual, expectedBuffer);
  } catch {
    return false;
  }
}

export function newSessionToken() {
  return randomBytes(32).toString('base64url');
}

export function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex');
}

function encryptionKey(secret) {
  return createHash('sha256').update(secret).digest();
}

export function encryptSecret(plainText, secret) {
  if (!plainText) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(secret), iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  return [b64u(iv), b64u(cipher.getAuthTag()), b64u(encrypted)].join('.');
}

export function decryptSecret(value, secret) {
  if (!value) return '';
  const [iv, tag, encrypted] = value.split('.').map(part => Buffer.from(part, 'base64url'));
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(secret), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

export function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').flatMap(part => {
    const index = part.indexOf('=');
    if (index < 0) return [];
    return [[part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())]];
  }));
}

// Привязка водителя к боту по контакту (аудит 14.11): принимаем ТОЛЬКО
// собственный контакт отправителя (кнопка request_contact шлёт его с
// user_id == from.id) и только в личном чате. Чужая карточка из
// записной книжки (user_id другой или пуст) или контакт в группе —
// отказ: иначе по одному лишь номеру телефона можно было стать любым
// водителем — видеть его рейсы и ставить отметки этапов.
export function telegramOwnContact(message) {
  const contact = message?.contact;
  if (!contact?.phone_number) return { ok: false, reason: 'no_contact' };
  if (message?.chat?.type !== 'private') return { ok: false, reason: 'not_private' };
  const fromId = message?.from?.id;
  if (fromId == null || contact.user_id == null || String(contact.user_id) !== String(fromId)) {
    return { ok: false, reason: 'foreign_contact' };
  }
  if (String(message.chat.id) !== String(fromId)) return { ok: false, reason: 'not_private' };
  return { ok: true, phone: contact.phone_number };
}

export function safeEqual(a = '', b = '') {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}
