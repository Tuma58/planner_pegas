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
