export async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers
    }
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && !location.pathname.endsWith('/login.html') && location.pathname !== '/') {
    location.href = '/login.html';
    throw new Error('Требуется вход');
  }
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

export const money = value =>
  `${Math.round(Number(value || 0)).toLocaleString('ru-RU')} ₽`;

export function toast(message, tone = '') {
  let element = document.querySelector('.toast');
  if (!element) {
    element = document.createElement('div');
    element.className = 'toast';
    document.body.append(element);
  }
  element.textContent = message;
  element.dataset.tone = tone;
  element.classList.add('visible');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove('visible'), 2500);
}

export function escapeHtml(value = '') {
  const element = document.createElement('span');
  element.textContent = String(value);
  return element.innerHTML;
}

export function formatDate(value, options = { day: '2-digit', month: 'short' }) {
  return new Intl.DateTimeFormat('ru-RU', options).format(new Date(value));
}

export async function logout() {
  await api('/api/auth/logout', { method: 'POST' });
  location.href = '/login.html';
}

export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('pl_theme', theme);
}

// Подключает кнопку #themeToggle и синхронизирует тему с сервером:
// локальный кеш применяется до первой отрисовки (инлайн-скрипт в head),
// серверное значение уточняется после загрузки.
export function setupTheme() {
  const button = document.getElementById('themeToggle');
  if (button) {
    button.onclick = () => {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      api('/api/preferences', { method: 'PUT', body: JSON.stringify({ theme: next }) }).catch(() => {});
    };
  }
  api('/api/preferences').then(({ theme }) => {
    if (theme && theme !== 'system' && theme !== document.documentElement.dataset.theme) applyTheme(theme);
  }).catch(() => {});
}
