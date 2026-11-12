import { api } from './api.js';

// Временный пароль (10.11): вошёл — но в планер не пускаем, пока не
// задан свой. Пароль, только что введённый на входе, подставляется сам.
let typedPassword = '';
function showChange(knownCurrent) {
  document.querySelector('#loginForm').classList.add('hidden');
  const form = document.querySelector('#changeForm');
  form.classList.remove('hidden');
  typedPassword = knownCurrent || '';
  document.querySelector('#changeCurrentField').classList.toggle('hidden', Boolean(typedPassword));
  form.querySelector(typedPassword ? '[name="next"]' : '[name="current"]').focus();
}

api('/api/auth/me').then(data => {
  if (data.user?.mustChangePassword) showChange('');
  else location.href = '/planner';
}).catch(() => {});

document.querySelector('#changeForm').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = new FormData(form);
  const error = document.querySelector('#changeError');
  error.textContent = '';
  if (values.get('next') !== values.get('repeat')) { error.textContent = 'Пароли не совпадают'; return; }
  try {
    await api('/api/me/password', { method: 'POST', body: JSON.stringify({
      current: typedPassword || String(values.get('current') || ''), next: String(values.get('next') || '') }) });
    location.href = '/planner';
  } catch (exception) { error.textContent = exception.message; }
});

// Рабочий телефон живёт у РАБОЧЕГО МЕСТА: дежурная трубка остаётся на
// столе, и следующей смене номер уже подставлен — осталось подтвердить
// входом (или поправить, если телефон сегодня другой).
const phoneField = document.querySelector('[name="workPhone"]');
try { phoneField.value = localStorage.getItem('pl_work_phone') || ''; } catch { /* приватный режим */ }

// Живая подсказка про новые логины (12.11): человек со старым листком
// набирает «Фамилия И» кириллицей — говорим про листок ещё до отправки,
// не дожидаясь ошибки входа (сервер на такой логин отвечает тем же).
const usernameField = document.querySelector('#loginForm [name="username"]');
const legacyHint = document.createElement('div');
legacyHint.className = 'muted';
legacyHint.style.cssText = 'font-size:12px;margin-top:4px;display:none';
legacyHint.textContent = '📋 С 11.11 логины латиницей вида ivanov.i — возьмите у руководителя листок с новым логином и временным паролем';
usernameField.insertAdjacentElement('afterend', legacyHint);
usernameField.addEventListener('input', () => {
  const value = usernameField.value.trim();
  legacyHint.style.display = /[а-яё]/i.test(value) || /\s/.test(value) ? '' : 'none';
});

document.querySelector('#loginForm').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button');
  const error = document.querySelector('#formError');
  button.disabled = true;
  error.textContent = '';
  try {
    const values = new FormData(form);
    const result = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: values.get('username'), password: values.get('password'),
        workPhone: String(values.get('workPhone') || '').trim() })
    });
    try { localStorage.setItem('pl_work_phone', String(values.get('workPhone') || '').trim()); } catch { /* ок */ }
    if (result.user?.mustChangePassword) { showChange(String(values.get('password') || '')); return; }
    location.href = '/planner';
  } catch (exception) {
    error.textContent = exception.message;
  } finally {
    button.disabled = false;
  }
});
