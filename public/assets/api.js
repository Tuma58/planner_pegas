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

// Эффективный конец занятости сцепки рейсом. Незавершённый рейс (план/в
// пути) держит машину до ФАКТА выгрузки: расчётный конец в прошлом сцепку
// не освобождает — рейс опаздывает, но машина едет (кейс р892ху58: ехала в
// Новосибирск, а по расчётному концу числилась «стоит»). Завершённый рейс
// освобождает по фактическому времени выгрузки (может быть раньше расчёта).
// Начало занятости: машина на линии с момента вывода (on_line_at), даже если
// плановая погрузка позже — едет на погрузку, ресурс занят; иначе — плановый старт.
export const tripBusyFromMs = trip => {
  const planned = Date.parse(trip.starts_at);
  const raw = String(trip.on_line_at || '');
  const onLine = raw ? Date.parse(raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`) : NaN;
  return Number.isFinite(onLine) ? Math.min(onLine, planned) : planned;
};
export const tripBusyUntilMs = (trip, nowMs = Date.now()) => {
  const planned = Date.parse(trip.ends_at);
  if (trip.status === 'plan' || trip.status === 'run') return Math.max(planned, nowMs);
  const raw = String(trip.unloaded_at || '');
  const fact = raw ? Date.parse(raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`) : NaN;
  return Number.isFinite(fact) ? fact : planned;
};

// Полная перерисовка блока (container.innerHTML) сбрасывает прокрутку всех
// его списков: клик по карточке в конце длинного списка «перекидывал
// вверх». Снимок прокрученных элементов (по классу и порядковому номеру)
// перед рендером и восстановление после — одна пара вызовов в каждом render*.
export function captureScrolls(root) {
  const saved = [];
  const walk = element => {
    if (element.scrollTop || element.scrollLeft) {
      const cls = element === root ? '' : String(element.className || '').split(/\s+/).filter(Boolean)[0];
      if (element === root || cls) {
        const index = cls ? [...root.querySelectorAll(`.${CSS.escape(cls)}`)].indexOf(element) : -1;
        saved.push({ cls, index, top: element.scrollTop, left: element.scrollLeft });
      }
    }
  };
  walk(root);
  root.querySelectorAll('*').forEach(walk);
  return saved;
}
export function restoreScrolls(root, saved) {
  for (const item of saved || []) {
    const element = item.cls ? root.querySelectorAll(`.${CSS.escape(item.cls)}`)[item.index] : root;
    if (element) { element.scrollTop = item.top; element.scrollLeft = item.left; }
  }
}

// Тихая перерисовка блока: если разметка не изменилась, DOM не трогаем
// вовсе. Автообновление раз в минуту перерисовывало экран при ЛЮБОМ
// изменении данных — даже когда на видимой вкладке ничего не менялось:
// экран мигал, списки перескакивали, прокрутка сбивалась. Возвращает
// false, если рендер не потребовался (вызывающий код может не навешивать
// обработчики заново — старые остались на тех же узлах).
// Отпечаток разметки держим НА САМОМ УЗЛЕ (data-render), а не во внешней
// карте: вкладки рисуют в один и тот же контейнер, и после переключения
// туда-обратно совпадение строки не означало бы, что в DOM сейчас именно
// она — экран остался бы от чужой вкладки.
function htmlFingerprint(text) {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) | 0;
  }
  return `${text.length}:${hash}`;
}
export function renderInto(container, html) {
  const fingerprint = htmlFingerprint(html);
  if (container.dataset.render === fingerprint) return false;
  container.innerHTML = html;
  container.dataset.render = fingerprint;
  return true;
}

// Полный снимок прокрутки страницы и всех прокручиваемых областей.
// В отличие от captureScrolls привязывается к позиции узла в дереве, а не
// к первому классу: пережидает перерисовку даже там, где классы совпадают.
export function captureViewScroll(root = document.body) {
  const path = element => {
    const parts = [];
    let node = element;
    while (node && node !== root && node.parentElement) {
      parts.push([...node.parentElement.children].indexOf(node));
      node = node.parentElement;
    }
    return parts.reverse().join('.');
  };
  const items = [];
  root.querySelectorAll('*').forEach(element => {
    if (element.scrollTop || element.scrollLeft) {
      items.push({ path: path(element), top: element.scrollTop, left: element.scrollLeft });
    }
  });
  return { window: { x: window.scrollX, y: window.scrollY }, items };
}
export function restoreViewScroll(snapshot, root = document.body) {
  if (!snapshot) return;
  for (const item of snapshot.items) {
    let node = root;
    for (const index of String(item.path).split('.').filter(part => part !== '')) {
      node = node?.children?.[Number(index)];
      if (!node) break;
    }
    if (node) { node.scrollTop = item.top; node.scrollLeft = item.left; }
  }
  if (snapshot.window.y || snapshot.window.x) window.scrollTo(snapshot.window.x, snapshot.window.y);
}

export const money = value =>
  `${Math.round(Number(value || 0)).toLocaleString('ru-RU')} ₽`;

// Сумма из пользовательского ввода: терпит копипаст с пробелами
// (в т.ч. неразрывными — так форматирует money()), знаком ₽ и запятой:
// «95 000 ₽» → 95000, «95000,50» → 95000.5. Нечисло — 0.
export function parseMoney(value) {
  const cleaned = String(value ?? '').replace(/[\s\u00a0\u202f\u20bd]/g, '').replace(',', '.');
  const num = Number(cleaned);
  return Number.isFinite(num) && num >= 0 ? num : 0;
}

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
// Поиск по длинному <select> (сцепки): фильтрует options по подстроке —
// номер, прицеп, водитель, тип — выбор без перелистывания. Первая
// подошедшая опция становится выбранной.
// ── Единый выбор периода ──
// Один формат на все экраны: ◀ дата ▶ и «Сегодня» (день) либо «с — по»
// со сдвигом стрелками на длину периода и пресетом «Месяц».
export const dayPickerHtml = (id, value, label = '') => `<span class="ppick">
  ${label ? `<small class="pp-label">${label}</small>` : ''}
  <button type="button" class="pp-btn" data-pp-shift="-1" data-pp-for="${id}" title="Предыдущий день">◀</button>
  <input type="date" id="${id}" value="${value}">
  <button type="button" class="pp-btn" data-pp-shift="1" data-pp-for="${id}" title="Следующий день">▶</button>
  <button type="button" class="pp-btn pp-today" data-pp-today data-pp-for="${id}" title="К сегодняшнему дню">Сегодня</button></span>`;
export function wireDayPicker(root, id, onChange) {
  const input = root.querySelector(`#${id}`);
  if (!input) return;
  const fire = () => input.value && onChange(input.value);
  root.querySelectorAll(`[data-pp-shift][data-pp-for="${id}"]`).forEach(button =>
    button.addEventListener('click', () => {
      const ms = Date.parse(`${input.value || new Date().toISOString().slice(0, 10)}T00:00:00Z`)
        + Number(button.dataset.ppShift) * 86_400_000;
      input.value = new Date(ms).toISOString().slice(0, 10);
      fire();
    }));
  root.querySelector(`[data-pp-today][data-pp-for="${id}"]`)?.addEventListener('click', () => {
    input.value = new Date().toISOString().slice(0, 10);
    fire();
  });
  input.addEventListener('change', fire);
}
export const rangePickerHtml = (idFrom, idTo, from, to, label = '') => `<span class="ppick">
  ${label ? `<small class="pp-label">${label}</small>` : ''}
  <button type="button" class="pp-btn" data-pp-range="-1" data-pp-for="${idFrom}" title="Назад на длину периода">◀</button>
  <input type="date" id="${idFrom}" value="${from}">
  <small class="pp-label">—</small>
  <input type="date" id="${idTo}" value="${to}">
  <button type="button" class="pp-btn" data-pp-range="1" data-pp-for="${idFrom}" title="Вперёд на длину периода">▶</button>
  <button type="button" class="pp-btn pp-today" data-pp-month data-pp-for="${idFrom}" title="Текущий месяц целиком">Месяц</button></span>`;
export function wireRangePicker(root, idFrom, idTo, onChange) {
  const inputFrom = root.querySelector(`#${idFrom}`);
  const inputTo = root.querySelector(`#${idTo}`);
  if (!inputFrom || !inputTo) return;
  const fire = () => inputFrom.value && inputTo.value && inputTo.value > inputFrom.value &&
    onChange(inputFrom.value, inputTo.value);
  root.querySelectorAll(`[data-pp-range][data-pp-for="${idFrom}"]`).forEach(button =>
    button.addEventListener('click', () => {
      const fromMs = Date.parse(`${inputFrom.value}T00:00:00Z`);
      const toMs = Date.parse(`${inputTo.value}T00:00:00Z`);
      const span = Math.max(86_400_000, toMs - fromMs);
      const shift = Number(button.dataset.ppRange) * span;
      inputFrom.value = new Date(fromMs + shift).toISOString().slice(0, 10);
      inputTo.value = new Date(toMs + shift).toISOString().slice(0, 10);
      fire();
    }));
  root.querySelector(`[data-pp-month][data-pp-for="${idFrom}"]`)?.addEventListener('click', () => {
    const now = new Date();
    inputFrom.value = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
    inputTo.value = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
    fire();
  });
  inputFrom.addEventListener('change', fire);
  inputTo.addEventListener('change', fire);
}

export function wireSelectSearch(input, select) {
  const all = [...select.options].map(option => ({
    html: option.outerHTML, text: option.textContent.toLowerCase()
  }));
  input.addEventListener('input', () => {
    const before = select.value;
    const needle = input.value.trim().toLowerCase();
    const kept = all.filter(item => !needle || item.text.includes(needle));
    select.innerHTML = kept.map(item => item.html).join('')
      || '<option value="" disabled selected>ничего не найдено</option>';
    // Пересборка опций меняет выбор селекта без события change, и зависимые
    // подсказки не пересчитываются — например, «⏭ Запланирован рейс…» в
    // назначении ТС показывала план прежней машины (кейс т508ве58).
    if (select.value !== before) select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

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
// Поле поиска, переживающее перерисовку блока: ввод не прерывается
// (перерисовка стартует после паузы в наборе), после неё фокус и каретка
// возвращаются в пересозданное поле. apply может быть асинхронным.
export function attachSearch(input, apply, delay = 250) {
  let timer = null;
  input.oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const value = input.value;
      const caret = input.selectionStart ?? value.length;
      await apply(value);
      // Перерисовка блока пересоздаёт поле поиска, и символы, набранные во
      // время рендера (в диспетчере он ещё и ходит в сеть), пропадали, а
      // каретка прыгала — «буквы скачут, приходится вводить заново».
      // Лечение: возвращаем в новую разметку ЖИВОЙ старый узел — у него
      // непрерывны значение, обработчик и набранный во время рендера текст.
      const again = document.getElementById(input.id);
      if (again && again !== input) again.replaceWith(input);
      if (document.activeElement !== input &&
          (document.activeElement === document.body || document.activeElement === null ||
           document.activeElement === again)) {
        input.focus();
        const position = Math.min(caret, input.value.length);
        input.setSelectionRange(position, position);
      }
      // Пользователь дописал текст, пока блок перерисовывался, —
      // догоняем состояние ещё одним циклом.
      if (input.value !== value) input.oninput();
    }, delay);
  };
}

// Транзитное время рейса, часов: (км ÷ 50 км/ч + 2 операции × 2 ч) × 1,5.
// Формула совпадает с серверной (transitHours в planner-service.mjs);
// коэффициент включает отдых водителя — после рейса сцепка готова к новому.
export function transitHours(distanceKm, calculation = {}, operations = 2) {
  const speed = Number(calculation.techSpeedKmh || 50);
  const perOperation = Number(calculation.handlingHoursPerOperation || 2);
  const factor = Number(calculation.transitFactor || 1.5);
  return (Number(distanceKm || 0) / speed + operations * perOperation) * factor;
}

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
