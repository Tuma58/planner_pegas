import { api } from './api.js';

api('/api/auth/me').then(() => { location.href = '/planner'; }).catch(() => {});

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
      body: JSON.stringify({ username: values.get('username'), password: values.get('password') })
    });
    location.href = '/planner';
  } catch (exception) {
    error.textContent = exception.message;
  } finally {
    button.disabled = false;
  }
});
