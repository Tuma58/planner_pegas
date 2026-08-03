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

// ── Часовой пояс предприятия ──────────────────────────────────────────────
// В базе время хранится в UTC, а планируется и отображается в часовом поясе
// предприятия (настройка «Настройки → Планер»), чтобы часы совпадали с 1С.
let planningTimeZone = 'Europe/Moscow';

export function setTimeZone(timeZone) {
  if (!timeZone) return;
  try {
    new Intl.DateTimeFormat('ru-RU', { timeZone }).format(new Date());
    planningTimeZone = timeZone;
  } catch { /* некорректная зона в настройках — остаёмся на прежней */ }
}

export const timeZone = () => planningTimeZone;

// Смещение зоны для конкретного момента (учитывает переход на летнее время).
function offsetMs(date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: planningTimeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(date).map(part => [part.type, part.value]));
  const shown = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour) % 24, Number(parts.minute), Number(parts.second));
  return shown - date.getTime();
}

// UTC → значение для <input type="datetime-local"> (время предприятия).
export function toLocalInput(value) {
  const date = new Date(value);
  return new Date(date.getTime() + offsetMs(date)).toISOString().slice(0, 16);
}

// Значение datetime-local (время предприятия) → ISO в UTC.
// Второй проход уточняет смещение, если момент попал на границу перевода часов.
export function fromLocalInput(value) {
  const naive = Date.parse(`${String(value).slice(0, 16)}:00.000Z`);
  if (!Number.isFinite(naive)) return null;
  let utc = naive - offsetMs(new Date(naive));
  utc = naive - offsetMs(new Date(utc));
  return new Date(utc).toISOString();
}

// Планирование ведётся до минут: метки времени показываются вместе с часами.
export function formatDateTime(value) {
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: planningTimeZone
  }).format(new Date(value));
}

// Значения формы с нормализацией полей datetime-local: браузер отдаёт их без
// часового пояса, трактуем как время предприятия и переводим в UTC.
export function formValues(form) {
  const values = Object.fromEntries(new FormData(form));
  for (const element of form.elements) {
    if (element.type === 'datetime-local' && element.name && values[element.name]) {
      values[element.name] = fromLocalInput(values[element.name]) ?? values[element.name];
    }
  }
  return values;
}

export async function logout() {
  await api('/api/auth/logout', { method: 'POST' });
  location.href = '/login.html';
}

// Маршрут «из пункта в пункт»: показываем конкретные пункты погрузки/выгрузки,
// геозона — фолбэк (и остаётся каркасом ставок, экономики и карты).
export function routeLabel(item) {
  const from = item.from_point || item.from_name || '';
  const to = item.to_point || item.to_name || '';
  return `${from} → ${to}`;
}

// Зональная строка для подписи под маршрутом — только если отличается от пунктов.
export function routeZones(item) {
  if (!item.from_point && !item.to_point) return '';
  return `${item.from_name} → ${item.to_name}`;
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
