import { api } from './api.js';

api('/api/auth/me').then(() => { location.href = '/planner'; }).catch(() => {});

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
    await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: values.get('username'), password: values.get('password'),
        workPhone: String(values.get('workPhone') || '').trim() })
    });
    try { localStorage.setItem('pl_work_phone', String(values.get('workPhone') || '').trim()); } catch { /* ок */ }
    location.href = '/planner';
  } catch (exception) {
    error.textContent = exception.message;
  } finally {
    button.disabled = false;
  }
});
