// Клиент SMS-центра (smsc.ru).
//
// Документация: https://smsc.ru/api/ — HTTP/HTTPS send.php и REST /rest/send/.
// Авторизация: login+psw или apikey. Имя отправителя — параметр sender
// (должно быть зарегистрировано в кабинете SMSC).
//
// Секрет .secrets/smsc_apikey: три строки (пароль, логин, отправитель)
// или одна строка (apikey). Дополнительно login/sender могут быть в settings.sms.

import { request as httpsRequest } from 'node:https';
import { phoneDigits } from './telephony.mjs';

export const SMSC_HOST = 'smsc.ru';

// Приводит номер к виду 7XXXXXXXXXX для SMSC (без «+»).
export function smscPhone(value) {
  const digits = phoneDigits(value);
  if (!digits) return '';
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits[0] === '7') return digits;
  return digits;
}

function postForm(path, params, { timeoutMs = 15_000 } = {}) {
  const body = new URLSearchParams(params).toString();
  return new Promise(resolve => {
    const request = httpsRequest({
      host: SMSC_HOST, family: 4, method: 'POST', path, timeout: timeoutMs,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      }
    }, response => {
      let raw = '';
      response.on('data', chunk => { raw += chunk; });
      response.on('end', () => {
        try { resolve({ ok: response.statusCode < 400, status: response.statusCode, data: JSON.parse(raw) }); }
        catch { resolve({ ok: false, status: response.statusCode, data: { error: raw.slice(0, 200) } }); }
      });
    });
    request.on('error', error => resolve({ ok: false, status: 0, data: { error: error.message } }));
    request.on('timeout', () => { request.destroy(); resolve({ ok: false, status: 0, data: { error: 'timeout' } }); });
    request.end(body);
  });
}

// Отправка одной или нескольких SMS. phones — строка/массив.
// Возвращает { ok, id, cnt, error, error_code, cost }.
export async function sendSms({ login, apikey, password, phones, text, sender, charset = 'utf-8' } = {}) {
  if (!login && !apikey) return { ok: false, error: 'не задан login/apikey SMSC' };
  const list = (Array.isArray(phones) ? phones : String(phones || '').split(/[,;]/))
    .map(smscPhone).filter(Boolean);
  if (!list.length) return { ok: false, error: 'нет номеров для SMS' };
  const mes = String(text || '').slice(0, 1000);
  if (!mes) return { ok: false, error: 'пустой текст SMS' };
  const params = {
    phones: list.join(','), mes, charset, fmt: '3'
  };
  if (apikey) params.apikey = apikey;
  else { params.login = login; params.psw = password || ''; }
  if (sender) params.sender = sender;
  if (login && apikey) params.login = login;
  const answer = await postForm('/sys/send.php', params);
  const data = answer.data || {};
  if (data.error || data.error_code) {
    return { ok: false, error: data.error || 'SMSC error', error_code: data.error_code, id: data.id };
  }
  return { ok: true, id: data.id, cnt: data.cnt, cost: data.cost, balance: data.balance };
}

export async function smscBalance({ login, apikey, password } = {}) {
  const params = { fmt: '3' };
  if (apikey) { params.apikey = apikey; if (login) params.login = login; }
  else { params.login = login; params.psw = password || ''; }
  const answer = await postForm('/sys/balance.php', params);
  const data = answer.data || {};
  if (data.error) return { ok: false, error: data.error, error_code: data.error_code };
  return { ok: true, balance: data.balance ?? data };
}
