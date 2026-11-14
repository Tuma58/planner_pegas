import test from 'node:test';
import assert from 'node:assert/strict';
import { telegramOwnContact } from '../src/security.mjs';

// Аудит 14.11: привязка водителя к боту — только свой контакт и личный чат.
const msg = (over = {}) => ({
  chat: { id: 111, type: 'private' },
  from: { id: 111 },
  contact: { phone_number: '+79001234567', user_id: 111 },
  ...over
});

test('свой контакт из кнопки request_contact в личке — принимается', () => {
  const result = telegramOwnContact(msg());
  assert.equal(result.ok, true);
  assert.equal(result.phone, '+79001234567');
});

test('чужая карточка из записной книжки — отказ', () => {
  assert.equal(telegramOwnContact(msg({ contact: { phone_number: '+79001234567', user_id: 222 } })).reason, 'foreign_contact');
});

test('контакт без user_id (номер не в Telegram или скрыт) — отказ', () => {
  assert.equal(telegramOwnContact(msg({ contact: { phone_number: '+79001234567' } })).reason, 'foreign_contact');
});

test('свой контакт, но в группе — отказ', () => {
  assert.equal(telegramOwnContact(msg({ chat: { id: -100500, type: 'group' } })).reason, 'not_private');
  assert.equal(telegramOwnContact(msg({ chat: { id: -100500, type: 'supergroup' } })).reason, 'not_private');
});

test('нет контакта — не привязка', () => {
  assert.equal(telegramOwnContact({ chat: { id: 1, type: 'private' }, from: { id: 1 }, text: 'привет' }).reason, 'no_contact');
});

test('id строкой и числом совпадают', () => {
  assert.equal(telegramOwnContact(msg({ contact: { phone_number: '89001234567', user_id: '111' } })).ok, true);
});
