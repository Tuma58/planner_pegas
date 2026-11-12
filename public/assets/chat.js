// Внутренний чат в стиле Telegram: список переписок с последним сообщением
// и счётчиками непрочитанных → лента-пузыри выбранной переписки.
// Виды переписок: «Общий» (все сотрудники), «⚙ Конвейер» (авто-уведомления
// процесса, каждому по его ролям — личная лента заданий), личные диалоги
// (видят только двое) и группы (создаются любым сотрудником, видят участники).
// Всплывающие системные уведомления браузера — включаются кнопкой 🖥 и
// работают, даже когда планер в фоновой вкладке. Поллинг raw JSON раз в 20 с.
import { api, escapeHtml, formatDateTime, toast } from './api.js';
import { kbSearch, kbSearchGuides } from './kb.js';
import { mountTickets, ticketForm } from './tickets.js';
import { GUIDES } from './guide.js';

const POLL_MS = 20_000;
const ROLE_LABELS = {
  logist: 'Логист', dispatcher: 'Диспетчер', sales: 'Планирование',
  accountant: 'Бухгалтерия', resource: 'Ресурс', manager: 'Руководитель',
  admin: 'Администратор', mechanic: 'Механик'
};

let audioContext = null;
// AudioContext разрешён только после жеста пользователя — создаём лениво.
function armAudio() {
  if (!audioContext) {
    try { audioContext = new (window.AudioContext || window.webkitAudioContext)(); } catch { /* нет звука */ }
  }
}

// Локальные настройки этого рабочего места (браузера).
const soundSettings = {
  muted: localStorage.getItem('pl_chat_muted') === '1',
  volume: Math.min(1, Math.max(0, Number(localStorage.getItem('pl_chat_volume') ?? 0.5)))
};
function saveSound() {
  localStorage.setItem('pl_chat_muted', soundSettings.muted ? '1' : '');
  localStorage.setItem('pl_chat_volume', String(soundSettings.volume));
}

// Сигналы без аудиофайлов: «вам» — двухтональный, прочее — одиночный тихий.
function beep(kind = 'target') {
  if (soundSettings.muted || soundSettings.volume <= 0) return;
  if (!audioContext || audioContext.state === 'suspended') return;
  const now = audioContext.currentTime;
  const peak = 0.24 * soundSettings.volume * (kind === 'target' ? 1 : 0.55);
  const tones = kind === 'target' ? [[880, 0], [660, 0.14]] : [[520, 0]];
  tones.forEach(([freq, offset]) => {
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.frequency.value = freq;
    gain.gain.setValueAtTime(0.001, now + offset);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.002, peak), now + offset + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, now + offset + 0.13);
    oscillator.connect(gain).connect(audioContext.destination);
    oscillator.start(now + offset);
    oscillator.stop(now + offset + 0.15);
  });
}

// Системные всплывающие уведомления браузера: видны и из фоновой вкладки.
const desktopEnabled = () => localStorage.getItem('pl_chat_desktop') === '1'
  && typeof Notification !== 'undefined' && Notification.permission === 'granted';
function desktopNotify(title, body) {
  if (!desktopEnabled()) return;
  try {
    const note = new Notification(title, { body, tag: 'pegas-chat', renotify: false });
    note.onclick = () => { window.focus(); note.close(); };
    setTimeout(() => note.close(), 8000);
  } catch { /* не поддерживается */ }
}

// Управление полноэкранным режимом (вкладка «💬 Мессенджер»): заполняется
// в setupChat, когда панель создана. Если вкладка открылась раньше
// (загрузка страницы прямо на мессенджере) — контейнер ждёт панель.
let pageControls = null;
let pendingPageContainer = null;
export function mountChatPage(container) {
  if (pageControls) pageControls.mount(container);
  else pendingPageContainer = container;
}
export function unmountChatPage() {
  if (pageControls) pageControls.unmount();
}

export function setupChat(state) {
  const toolbarEnd = document.querySelector('.toolbar-end');
  if (!toolbarEnd || document.getElementById('chatToggle')) return;
  const toggle = document.createElement('button');
  toggle.id = 'chatToggle';
  toggle.className = 'tb-icon chat-toggle';
  toggle.title = 'Чат: общий канал, лента конвейера, личные и группы';
  toggle.innerHTML = '💬<span class="chat-unread hidden" id="chatUnread">0</span>';
  toolbarEnd.prepend(toggle);

  const myRoles = state.data.user.roles || [state.data.user.role];
  // 📐 Тех. задание (10.11) — комната руководителей: с «Полем» в наборе
  // или (без наборов) manager/admin. Сервер проверяет то же самое.
  const myAccess = state.data.user.access;
  const canTz = !myAccess || myAccess.legacy
    ? myRoles.some(role => ['manager', 'admin'].includes(role))
    : (myAccess.views || []).includes('field');
  const myId = state.data.user.id;

  const panel = document.createElement('aside');
  panel.className = 'chat-panel hidden';
  panel.innerHTML = `
    <div class="chat-head" id="chatHomeHead">
      <strong>Чат</strong>
      <span class="chat-sound" title="Звук уведомлений этого рабочего места">
        <button class="button ghost small" id="chatDesktop"
          title="Всплывающие уведомления на экране — приходят, даже когда планер в фоновой вкладке">${localStorage.getItem('pl_chat_desktop') === '1' ? '🖥' : '🚫🖥'}</button>
        <button class="button ghost small" id="chatMute"
          title="Выключить/включить звук уведомлений">${soundSettings.muted ? '🔕' : '🔔'}</button>
        <input type="range" id="chatVolume" min="0" max="100" step="5"
          value="${Math.round(soundSettings.volume * 100)}" title="Громкость уведомлений">
      </span>
      <button class="button ghost small" id="chatNew" title="Новое личное сообщение или группа">✚</button>
      <button class="button ghost small" id="chatClose">✕</button>
    </div>
    <div class="chat-head hidden" id="chatDialogHead">
      <button class="button ghost small" id="chatBack">←</button>
      <span style="flex:1;min-width:0"><strong id="chatDialogTitle"></strong>
        <small class="muted" id="chatDialogSub" style="display:block"></small></span>
      <button class="button ghost small" id="chatPin" title="Закрепить переписку сверху списка">📌</button>
      <button class="button ghost small" id="chatMuteRoom" title="Без звука и всплывающих — счётчик остаётся">🔔</button>
      <button class="button ghost small hidden" id="chatGroupEdit" title="Состав и название группы">⚙</button>
      <button class="button ghost small hidden" id="chatDelete" title="Удалить переписку">🗑</button>
    </div>
    <div class="chat-search" id="chatSearchWrap">
      <input id="chatSearchMsg" class="block-search" placeholder="🔎 Поиск по сообщениям…" autocomplete="off">
    </div>
    <div class="chat-rooms" id="chatRooms"></div>
    <div class="chat-list hidden" id="chatList"></div>
    <div class="chat-compose hidden" id="chatCompose"></div>
    <div class="chat-replybar hidden" id="chatReplyBar"></div>
    <div class="chat-mentions hidden" id="chatMentions"></div>
    <form class="chat-form hidden" id="chatForm">
      <button type="button" class="button ghost small" id="chatAttach" title="Прикрепить файл: фото, видео, документ">📎</button>
      <input type="file" id="chatFile" class="hidden"
        accept=".png,.jpg,.jpeg,.webp,.gif,.mp4,.webm,.mov,.md,.txt,.csv,.xlsx,.xls,.pdf,.docx,.doc">
      <input id="chatInput" placeholder="Сообщение…" autocomplete="off" maxlength="500">
      <button class="button small">➤</button>
    </form>`;
  document.body.appendChild(panel);

  const el = id => panel.querySelector(`#${id}`);
  const list = el('chatList');
  const rooms = el('chatRooms');
  const input = el('chatInput');
  const unreadBadge = document.getElementById('chatUnread');
  const isOpen = () => !panel.classList.contains('hidden');
  // Адресовано мне: авто-уведомление моей роли либо персональное (recipient_id).
  const forMe = message => (message.target_role && myRoles.includes(message.target_role))
    || (message.kind === 'auto' && message.recipient_id === myId);

  // Модель: все видимые сообщения, группы, собеседники; активная переписка.
  const allMessages = [];
  let groups = [];
  let contacts = [];
  let hiddenRooms = [];   // скрытые у себя лички: [{room_key, hidden_after}]
  let deletedGroups = []; // корзина удалённых групп (только админ)
  let lastId = Number(localStorage.getItem('pl_chat_last') || 0);
  // Метка последнего опроса (время сервера) — по ней докачиваются правки
  // и удаления сообщений, сделанные коллегами между опросами.
  let pollSince = '';
  // Докуда дочитал собеседник в активной личке (галочки ✓✓) и кто печатает.
  let peerReadId = null;
  let typingNames = [];
  // Прикреплённый, но ещё не отправленный файл: {id, name, mime}.
  let pendingMedia = null;
  // Закрепления и «тишина» переписок (серверные, ключи нормализованные).
  let prefs = [];
  const normKey = key => key.startsWith('dm:')
    ? `dm:${[key.slice(3), myId].sort().join(':')}` : key;
  const prefOf = key => prefs.find(item => item.room_key === normKey(key)) || { pinned: 0, muted: 0 };
  // Активная переписка: {kind: 'all'|'auto'|'dm'|'group', id?: peerId|chatId}
  let active = null;
  let seen = {};
  try { seen = JSON.parse(localStorage.getItem('pl_chat_seen_v2') || '{}') || {}; } catch { seen = {}; }
  const saveSeen = () => localStorage.setItem('pl_chat_seen_v2', JSON.stringify(seen));
  // Первый запуск новой версии чата на этом рабочем месте: вся уже
  // существующая история считается прочитанной — счётчики только для нового.
  let freshStart = !localStorage.getItem('pl_chat_seen_v2');

  // Ключ переписки для сообщения (с чьей стороны смотрим — myId).
  const roomKeyOf = message => {
    if (message.chat_id) return `group:${message.chat_id}`;
    // Персональные авто-сообщения (отчёт дня, ревизия зазоров плана) — своя
    // личная лента «📬 Планер — лично»: в общем конвейере они тонули среди
    // ролевых уведомлений, а это адресовано именно вам.
    if (message.kind === 'auto') return message.recipient_id ? 'personal' : 'auto';
    if (message.recipient_id) {
      return `dm:${message.author_id === myId ? message.recipient_id : message.author_id}`;
    }
    return message.kind === 'auto' ? 'auto' : 'all';
  };
  const peerName = id => contacts.find(item => item.id === id)?.full_name
    || allMessages.find(m => m.author_id === id && m.author_name)?.author_name || 'Сотрудник';
  const shortName = full => {
    const [last, first] = String(full).split(' ');
    return first ? `${last} ${first[0]}.` : last;
  };
  const initials = full => String(full).split(' ').slice(0, 2).map(word => word[0] || '').join('').toUpperCase();

  const roomTitle = key => {
    if (key === 'all') return '📢 Общий';
    if (key === 'auto') return '⚙ Конвейер';
    if (key === 'personal') return '📬 Планер — лично';
    if (key === 'helpdesk') return '🛟 HELP DESK';
    if (key === 'tz') return '📐 Тех. задание';
    if (key === 'kb') return '❓ Справка';
    if (key.startsWith('dm:')) return peerName(key.slice(3));
    const group = groups.find(item => item.id === key.slice(6));
    return group ? `👥 ${group.title}` : '👥 Группа';
  };
  const unreadOf = key => allMessages.filter(m => roomKeyOf(m) === key &&
    m.id > (seen[key] || 0) && m.author_id !== myId).length;

  // Список переписок: закреплённые «Общий» и «Конвейер», затем диалоги и
  // группы по времени последнего сообщения (как в Telegram).
  const roomList = () => {
    const keys = new Set(['all', 'auto', 'personal', 'helpdesk', 'kb', ...(canTz ? ['tz'] : [])]);
    for (const message of allMessages) keys.add(roomKeyOf(message));
    for (const group of groups) keys.add(`group:${group.id}`);
    const lastMsg = {};
    for (const message of allMessages) {
      const key = roomKeyOf(message);
      if (!lastMsg[key] || message.id > lastMsg[key].id) lastMsg[key] = message;
    }
    const pinned = ['all', 'personal', 'auto', 'helpdesk', ...(canTz ? ['tz'] : []), 'kb'];
    const rest = [...keys].filter(key => !pinned.includes(key))
      .filter(key => {
        // Удалённая группа пропадает из списка сразу (сообщения в памяти не в счёт).
        if (key.startsWith('group:')) return groups.some(group => group.id === key.slice(6));
        const hidden = hiddenRooms.find(item => item.room_key === key);
        return !hidden || (lastMsg[key]?.id || 0) > hidden.hidden_after;
      })
      .sort((a, b) => (prefOf(b).pinned - prefOf(a).pinned)
        || (lastMsg[b]?.id || 0) - (lastMsg[a]?.id || 0));
    return [...pinned, ...rest].map(key => ({ key, last: lastMsg[key] || null }));
  };

  // Поиск по всем моим перепискам (Э2): результаты встают вместо списка
  // комнат, клик открывает переписку. Пустой ввод — обычный список.
  let searchTimer = null;
  el('chatSearchMsg').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      const query = el('chatSearchMsg').value.trim();
      if (query.length < 2) { renderRooms(); return; }
      try {
        const { items } = await api(`/api/messages/search?q=${encodeURIComponent(query)}`);
        rooms.innerHTML = items.length ? items.map(message => {
          const key = roomKeyOf(message);
          return `<div class="chat-room" data-room="${key}">
            <span class="chat-ava">${key === 'all' ? '📢' : key === 'auto' ? '⚙'
              : key.startsWith('group:') ? '👥' : initials(message.author_name)}</span>
            <span class="chat-room-body"><b>${escapeHtml(message.author_name)}</b>
              <small class="muted" style="display:block">${escapeHtml(message.text.slice(0, 90))}</small>
              <small class="muted">${formatDateTime(message.created_at.includes('Z')
                ? message.created_at : message.created_at.replace(' ', 'T') + 'Z')} · ${escapeHtml(roomTitle(key))}</small></span>
          </div>`;
        }).join('') : '<div class="muted" style="padding:12px;text-align:center">Ничего не найдено</div>';
        rooms.querySelectorAll('[data-room]').forEach(row =>
          row.addEventListener('click', () => {
            el('chatSearchMsg').value = '';
            openRoom(row.dataset.room);
          }));
      } catch { /* сеть */ }
    }, 300);
  });

  const renderRooms = () => {
    rooms.innerHTML = roomList().map(({ key, last }) => {
      const count = unreadOf(key);
      const title = roomTitle(key);
      const avatar = key === 'all' ? '📢' : key === 'auto' ? '⚙' : key === 'personal' ? '📬'
        : key === 'helpdesk' ? '🛟' : key === 'tz' ? '📐' : key === 'kb' ? '❓'
        : key.startsWith('group:') ? '👥' : initials(title);
      const time = last ? formatDateTime(last.created_at.includes('Z')
        ? last.created_at : last.created_at.replace(' ', 'T') + 'Z') : '';
      const preview = last
        ? `${last.author_id === myId ? 'Вы: ' : (key.startsWith('group:') || key === 'all')
            ? `${shortName(last.author_name || '⚙')}: ` : ''}${last.text}`
        : (key === 'auto' ? 'Уведомления процесса — по вашим ролям'
          : key === 'personal' ? 'Личные отчёты планера: отчёт дня, ревизия зазоров'
          : key === 'helpdesk' ? 'Заявки на доработку планера — что мешает в работе'
          : key === 'tz' ? 'Доработка нового продукта с руководителями'
          : key === 'kb' ? 'База знаний: поиск по статьям и инструкциям'
          : 'Сообщений пока нет');
      return `<div class="chat-room ${count ? 'has-unread' : ''}" data-room="${key}">
        <span class="chat-ava ${key.startsWith('dm:') ? 'human' : ''}">${avatar}</span>
        <span class="chat-room-body">
          <span class="chat-room-top"><b>${escapeHtml(title.replace(/^([📢⚙👥] )/, '$1'))}</b>
            <small class="muted">${time}</small></span>
          <span class="chat-room-bottom"><small class="muted">${escapeHtml(String(preview).slice(0, 64))}</small>
            ${count ? `<span class="chat-unread">${count}</span>` : ''}</span>
        </span>
      </div>`;
    }).join('');
    if (deletedGroups.length) {
      rooms.insertAdjacentHTML('beforeend', `<details class="chat-trash">
        <summary>🗄 Корзина: удалённые группы (${deletedGroups.length})</summary>
        ${deletedGroups.map(group => `<div class="chat-room">
          <span class="chat-ava">🗄</span>
          <span class="chat-room-body"><b>${escapeHtml(group.title)}</b>
            <small class="muted" style="display:block">участников ${group.members_count}
              · сообщений ${group.messages_count}</small></span>
          <button class="button ghost small" data-restore="${group.id}"
            title="Вернуть группу всем участникам вместе с историей">↩ Восстановить</button>
        </div>`).join('')}
      </details>`);
      rooms.querySelectorAll('[data-restore]').forEach(button =>
        button.addEventListener('click', async event => {
          event.stopPropagation();
          try {
            await api(`/api/chats/${button.dataset.restore}/restore`, { method: 'POST' });
            toast('Группа восстановлена');
            await loadGroups();
            renderRooms();
          } catch (error) { toast(error.message, 'error'); }
        }));
    }
    rooms.querySelectorAll('[data-room]').forEach(row =>
      row.addEventListener('click', () => openRoom(row.dataset.room)));
  };

  // Окно правки/удаления своих сообщений — как на сервере (48 часов).
  const EDIT_WINDOW_MS = 48 * 3_600_000;
  const editableByMe = message => message.kind === 'user' && message.author_id === myId
    && !message.deleted_at
    && Date.now() - Date.parse(message.created_at.includes('Z')
      ? message.created_at : message.created_at.replace(' ', 'T') + 'Z') < EDIT_WINDOW_MS;

  const bubble = message => {
    const own = message.author_id === myId;
    const auto = message.kind === 'auto';
    const groupish = active?.key === 'all' || active?.key?.startsWith('group:');
    if (message.deleted_at) {
      return `<div class="chat-bubble-row ${own ? 'own' : ''}">
        <div class="chat-bubble deleted ${own ? 'own' : ''}"><small class="muted">🗑 сообщение удалено</small></div>
      </div>`;
    }
    // Цитата (ответ): короткий хвост оригинала, клик — ничего (якорей нет).
    const quote = message.reply_to_id ? `<div class="chat-quote">
        <small>${escapeHtml(message.reply_author || '…')}</small>
        <span>${message.reply_text ? escapeHtml(message.reply_text) : '<i class="muted">сообщение удалено</i>'}</span>
      </div>` : '';
    // Вложение: картинка/видео — сразу в пузыре, остальное — карточкой.
    const mediaUrl = message.media_id ? `/api/chat-media/${message.media_id}` : '';
    const media = !message.media_id ? ''
      : /^image\//.test(message.media_mime || '')
        ? `<a href="${mediaUrl}" target="_blank" rel="noopener"><img class="chat-media" src="${mediaUrl}" alt=""></a>`
      : /^video\//.test(message.media_mime || '')
        ? `<video class="chat-media" src="${mediaUrl}" controls preload="metadata"></video>`
        : `<a class="chat-file" href="${mediaUrl}" target="_blank" rel="noopener">📄 ${escapeHtml(message.media_name || 'файл')}</a>`;
    // Реакции: группировка по эмодзи, моя — подсвечена (повторный клик снимает).
    let reactions = [];
    try { reactions = JSON.parse(message.reactions || '[]'); } catch { reactions = []; }
    const reactionGroups = {};
    for (const item of reactions) {
      (reactionGroups[item.emoji] = reactionGroups[item.emoji] || { count: 0, mine: false, names: [] });
      reactionGroups[item.emoji].count += 1;
      reactionGroups[item.emoji].names.push(item.name);
      if (item.userId === myId) reactionGroups[item.emoji].mine = true;
    }
    const reactionsHtml = Object.keys(reactionGroups).length
      ? `<div class="chat-reactions">${Object.entries(reactionGroups).map(([emoji, group]) =>
        `<button type="button" class="chat-react-chip ${group.mine ? 'mine' : ''}"
          data-react="${emoji}" data-react-msg="${message.id}"
          title="${escapeHtml(group.names.join(', '))}">${emoji} ${group.count}</button>`).join('')}</div>`
      : '';
    // Галочки доставки в личке: ✓ отправлено, ✓✓ собеседник открыл переписку.
    const ticks = own && active?.key?.startsWith('dm:')
      ? `<span class="chat-ticks">${peerReadId !== null && message.id <= peerReadId ? '✓✓' : '✓'}</span>` : '';
    // @упоминания подсвечиваются в тексте.
    const textHtml = escapeHtml(message.text)
      .replace(/(^|\s)(@[\wа-яёА-ЯЁ.]+)/g, '$1<b class="chat-mention">$2</b>');
    return `<div class="chat-bubble-row ${own ? 'own' : ''}" data-msg-id="${message.id}">
      <div class="chat-bubble ${own ? 'own' : ''} ${auto ? 'auto' : ''} ${forMe(message) ? 'mine-target' : ''}">
        ${!own && (groupish || auto) ? `<small class="chat-author">${auto
          ? `⚙ Конвейер${message.target_role ? ` → ${ROLE_LABELS[message.target_role] || message.target_role}` : ''}`
          : escapeHtml(message.author_name)}</small>` : ''}
        ${quote}${media}
        ${message.text ? `<div>${textHtml}</div>` : ''}
        ${reactionsHtml}
        <small class="chat-time">${formatDateTime(message.created_at.includes('Z')
          ? message.created_at : message.created_at.replace(' ', 'T') + 'Z')}${message.updated_at
          ? ' <span class="muted" title="Автор правил сообщение">· изм.</span>' : ''}${ticks}
          <span class="chat-msg-actions">
            ${message.kind === 'user' ? `<button type="button" class="chat-act" data-react-pick="${message.id}" title="Реакция">😊</button>` : ''}
            ${message.kind === 'user' && active && !['auto', 'personal'].includes(active.key)
    ? `<button type="button" class="chat-act" data-reply-msg="${message.id}" title="Ответить цитатой">↩</button>` : ''}
            <button type="button" class="chat-act" data-copy-msg="${message.id}" title="Скопировать текст">📋</button>
            <button type="button" class="chat-act" data-forward-msg="${message.id}" title="Переслать в другую переписку">↪</button>
            ${editableByMe(message)
    ? `<button type="button" class="chat-act" data-edit-msg="${message.id}" title="Исправить (48 ч)">✎</button>
       <button type="button" class="chat-act" data-delete-msg="${message.id}" title="Удалить (48 ч)">🗑</button>` : ''}
          </span></small>
      </div>
    </div>`;
  };

  // Копирование текста сообщения (с запасным путём для старых браузеров).
  const copyText = async value => {
    try { await navigator.clipboard.writeText(value); } catch {
      const helper = document.createElement('textarea');
      helper.value = value; document.body.append(helper);
      helper.select(); document.execCommand('copy'); helper.remove();
    }
  };

  // Пересылка: выбор переписки-получателя, текст уходит с пометкой автора.
  const forwardView = message => {
    el('chatHomeHead').classList.remove('hidden');
    el('chatDialogHead').classList.add('hidden');
    rooms.classList.add('hidden');
    list.classList.add('hidden');
    el('chatForm').classList.add('hidden');
    const box = el('chatCompose');
    box.classList.remove('hidden');
    const author = message.kind === 'auto' ? '⚙ Конвейер' : message.author_name;
    const targets = [
      { key: 'all', label: '📢 Общий', sub: 'все сотрудники' },
      ...groups.map(group => ({ key: `group:${group.id}`, label: `👥 ${group.title}`,
        sub: group.members.map(member => shortName(member.name)).join(', ') })),
      ...contacts.map(item => ({ key: `dm:${item.id}`, label: item.full_name,
        sub: (item.roles || []).map(role => ROLE_LABELS[role] || role).join(', ') }))
    ];
    box.innerHTML = `<div class="cmp-wrap">
      <div class="cmp-head">
        <b>↪ Переслать</b>
        <button class="button ghost small" id="fwdCancel" style="margin-left:auto">Отмена</button>
      </div>
      <div class="cmp-fixed">
        <div class="chat-fwd-preview"><small class="muted">${escapeHtml(author)}:</small>
          ${escapeHtml(message.text.slice(0, 160))}${message.text.length > 160 ? '…' : ''}</div>
        <input id="fwdSearch" class="block-search" placeholder="Куда переслать: поиск…"
          style="width:100%;margin-top:6px">
      </div>
      <div class="cmp-list">${targets.map(target =>
        `<div class="chat-room" data-fwd="${target.key}">
          <span class="chat-ava ${target.key.startsWith('dm:') ? 'human' : ''}">${target.key === 'all' ? '📢'
            : target.key.startsWith('group:') ? '👥' : initials(target.label)}</span>
          <span class="chat-room-body"><b>${escapeHtml(target.label.replace(/^[📢👥] /, ''))}</b>
            <small class="muted" style="display:block">${escapeHtml(target.sub)}</small></span>
        </div>`).join('')}</div>
    </div>`;
    box.querySelector('#fwdSearch').oninput = event => {
      const query = event.target.value.toLowerCase();
      box.querySelectorAll('[data-fwd]').forEach(row =>
        row.classList.toggle('hidden', !row.textContent.toLowerCase().includes(query)));
    };
    box.querySelector('#fwdCancel').onclick = () => active ? openRoom(active.key) : showHome();
    box.querySelectorAll('[data-fwd]').forEach(row =>
      row.addEventListener('click', async () => {
        const key = row.dataset.fwd;
        const payload = { text: `↪ ${author}: ${message.text}`.slice(0, 500) };
        if (key.startsWith('dm:')) payload.recipientId = key.slice(3);
        if (key.startsWith('group:')) payload.chatId = key.slice(6);
        try {
          await api('/api/messages', { method: 'POST', body: JSON.stringify(payload) });
          await poll();
          toast('Переслано');
          openRoom(key);
        } catch (error) { toast(error.message, 'error'); }
      }));
  };

  // ── Ответ-цитата и правка: плашка над полем ввода ──
  let composing = { replyTo: null, editing: null };
  const replyBar = el('chatReplyBar');
  const renderReplyBar = () => {
    const target = composing.editing || composing.replyTo;
    replyBar.classList.toggle('hidden', !target && !pendingMedia);
    if (!target && !pendingMedia) { replyBar.innerHTML = ''; return; }
    if (!target) {
      replyBar.innerHTML = `<span class="chat-rb-icon">📎</span>
        <span class="chat-rb-body"><small>Вложение</small>
          <span>${escapeHtml(pendingMedia.name)}</span></span>
        <button type="button" class="button ghost small" id="chatRbCancel">✕</button>`;
      replyBar.querySelector('#chatRbCancel').onclick = () => {
        pendingMedia = null;
        renderReplyBar();
      };
      return;
    }
    replyBar.innerHTML = `<span class="chat-rb-icon">${composing.editing ? '✎' : '↩'}</span>
      <span class="chat-rb-body"><small>${composing.editing ? 'Правка сообщения'
    : `Ответ: ${escapeHtml(target.author_name)}`}</small>
        <span>${escapeHtml(target.text.slice(0, 120))}</span></span>
      <button type="button" class="button ghost small" id="chatRbCancel">✕</button>`;
    replyBar.querySelector('#chatRbCancel').onclick = () => {
      if (composing.editing) input.value = '';
      composing = { replyTo: null, editing: null };
      renderReplyBar();
    };
  };
  const startReply = message => {
    composing = { replyTo: message, editing: null };
    renderReplyBar();
    input.focus();
  };
  const startEdit = message => {
    composing = { replyTo: null, editing: message };
    input.value = message.text;
    renderReplyBar();
    input.focus();
  };

  // Делегированные действия на пузырях: ответ, копирование, пересылка,
  // правка и удаление своих.
  list.addEventListener('click', async event => {
    const find = attr => {
      const button = event.target.closest(`[data-${attr}]`);
      return button ? allMessages.find(m => m.id === Number(button.dataset[attr.replace(/-([a-z])/g, (_, c) => c.toUpperCase())])) : null;
    };
    const copyMessage = find('copy-msg');
    if (copyMessage) { await copyText(copyMessage.text); toast('Сообщение скопировано'); return; }
    const forwardMessage = find('forward-msg');
    if (forwardMessage) { forwardView(forwardMessage); return; }
    const replyMessage = find('reply-msg');
    if (replyMessage) { startReply(replyMessage); return; }
    const editMessage = find('edit-msg');
    if (editMessage) { startEdit(editMessage); return; }
    const reactPick = event.target.closest('[data-react-pick]');
    if (reactPick) {
      // Мини-поповер с шестью реакциями прямо у кнопки.
      document.querySelector('.chat-react-pop')?.remove();
      const pop = document.createElement('div');
      pop.className = 'chat-react-pop';
      pop.innerHTML = ['👍', '❤️', '😂', '😮', '😢', '🔥'].map(emoji =>
        `<button type="button" data-pop-react="${emoji}">${emoji}</button>`).join('');
      reactPick.closest('.chat-bubble').appendChild(pop);
      pop.querySelectorAll('[data-pop-react]').forEach(button =>
        button.addEventListener('click', async () => {
          pop.remove();
          try {
            await api(`/api/messages/${reactPick.dataset.reactPick}/react`, { method: 'POST',
              body: JSON.stringify({ emoji: button.dataset.popReact }) });
            await poll();
            renderDialog();
          } catch (error) { toast(error.message, 'error'); }
        }));
      setTimeout(() => document.addEventListener('click',
        () => pop.remove(), { once: true }), 0);
      return;
    }
    const reactChip = event.target.closest('[data-react-msg]');
    if (reactChip) {
      try {
        await api(`/api/messages/${reactChip.dataset.reactMsg}/react`, { method: 'POST',
          body: JSON.stringify({ emoji: reactChip.dataset.react }) });
        await poll();
        renderDialog();
      } catch (error) { toast(error.message, 'error'); }
      return;
    }
    const deleteTarget = find('delete-msg');
    if (deleteTarget) {
      if (!confirm('Удалить сообщение? Останется пометка «удалено».')) return;
      try {
        await api(`/api/messages/${deleteTarget.id}`, { method: 'DELETE' });
        deleteTarget.text = '';
        deleteTarget.deleted_at = new Date().toISOString();
        renderDialog();
      } catch (error) { toast(error.message, 'error'); }
    }
  });

  // ── 🛟 HELP DESK: заявки на доработку планера (02.11) ──
  // Комната без переписки: лента карточек-заявок + форма «Новая заявка».
  // Заявки видят все (видно, что уже заявлено коллегами), решение о
  // выполнении — статусами на карточке — принимает только руководитель.
  const canDecide = myRoles.some(role => ['manager', 'admin'].includes(role));
  // Карточка, форма и статусы — общий модуль tickets.js (тот же, что у
  // «📐 Тех. задания» руководителей в АРМ, 10.11).
  const renderHelpdesk = () => mountTickets(list, {
    kind: 'helpdesk', canDecide, kb: true,
    stillHere: () => active?.key === 'helpdesk',
    onKb: ticket => {
      openRoom('kb');
      kbFormView({ question: ticket.problem, answer: ticket.decision_note || '',
        section: ticket.place, source: `helpdesk:${ticket.id}` });
    }
  });
  const hdFormView = () => ticketForm(list, { kind: 'helpdesk', onDone: renderHelpdesk });
  const renderTz = () => mountTickets(list, { kind: 'tz', canDecide, stillHere: () => active?.key === 'tz' });

  // ── ❓ Справка: база знаний с поиском (этап 1 помощника, 02.11) ──
  // Поиск сразу по двум источникам: статьи «вопрос → ответ» (копятся из
  // заявок HELP DESK и пишутся руководителем) и инструкции «?» (GUIDES).
  // Вопрос без ответа логируется — руководитель видит дыры базы.
  let kbArticles = [];
  let kbMisses = [];
  let kbLastMissLogged = '';
  let kbVoted = {};
  try { kbVoted = JSON.parse(localStorage.getItem('pl_kb_voted') || '{}') || {}; } catch { kbVoted = {}; }

  const kbArticleCard = article => {
    const useful = article.helped - article.not_helped;
    return `<div class="hd-card">
      <div class="hd-head"><b>${escapeHtml(article.question)}</b></div>
      <div style="white-space:pre-wrap">${escapeHtml(article.answer)}</div>
      <div class="hd-head"><small class="muted">${article.section ? `${escapeHtml(article.section)} · ` : ''}${escapeHtml(article.created_by_name)}</small>
        <span style="margin-left:auto;display:flex;gap:4px">
          ${kbVoted[article.id] ? `<small class="muted">спасибо за оценку</small>`
    : `<button class="button ghost small" data-kb-vote="1" data-kb-id="${article.id}" title="Ответ помог">👍${article.helped ? ` ${article.helped}` : ''}</button>
       <button class="button ghost small" data-kb-vote="" data-kb-id="${article.id}" title="Не помогло — статью перепишут">👎</button>`}
          ${canDecide ? `<button class="button ghost small" data-kb-edit="${article.id}" title="Исправить статью">✎</button>` : ''}
          ${useful < 0 ? `<span class="badge warn" title="Минусов больше, чем плюсов — статья ждёт переписывания">⚠</span>` : ''}
        </span></div>
    </div>`;
  };

  // Форма статьи (руководитель/админ): новая, правка или из заявки HELP DESK.
  const kbFormView = (prefill = {}, existingId = null) => {
    list.innerHTML = `<form class="hd-form" id="kbForm">
      <b>${existingId ? '✎ Правка статьи' : '📚 Новая статья базы знаний'}</b>
      <input name="question" maxlength="300" required placeholder="Вопрос — как его задал бы сотрудник"
        value="${escapeHtml(prefill.question || '')}">
      <input name="section" maxlength="60" placeholder="Раздел (например: Логист, Планирование, Общее)"
        value="${escapeHtml(prefill.section || '')}">
      <textarea name="answer" rows="6" maxlength="2000" required
        placeholder="Ответ — по шагам, с настоящими названиями кнопок">${escapeHtml(prefill.answer || '')}</textarea>
      <div class="hd-actions">
        <button class="button small" type="submit">💾 Сохранить</button>
        <button class="button ghost small" type="button" id="kbCancel">Отмена</button>
        ${existingId ? `<button class="button ghost small" type="button" id="kbDelete" style="margin-left:auto">🗑 Удалить</button>` : ''}
      </div>
    </form>`;
    list.querySelector('#kbCancel').onclick = () => renderKb();
    const deleteButton = list.querySelector('#kbDelete');
    if (deleteButton) {
      deleteButton.onclick = async () => {
        if (!confirm('Удалить статью из базы знаний?')) return;
        try {
          await api(`/api/kb/${existingId}`, { method: 'DELETE' });
          toast('Статья удалена');
          renderKb();
        } catch (error) { toast(error.message, 'error'); }
      };
    }
    list.querySelector('#kbForm').onsubmit = async event => {
      event.preventDefault();
      const form = event.target;
      const body = {
        question: form.question.value.trim(), answer: form.answer.value.trim(),
        section: form.section.value.trim(), source: prefill.source || ''
      };
      try {
        await api(existingId ? `/api/kb/${existingId}` : '/api/kb',
          { method: existingId ? 'PATCH' : 'POST', body: JSON.stringify(body) });
        toast(existingId ? 'Статья обновлена' : 'Статья добавлена в базу знаний');
        renderKb();
      } catch (error) { toast(error.message, 'error'); }
    };
  };

  const kbResultsHtml = query => {
    if (!query || query.trim().length < 3) {
      const recent = kbArticles.slice(0, 5);
      return `${recent.length ? `<div class="hd-top"><small class="muted">Свежие статьи:</small></div>` + recent.map(kbArticleCard).join('')
        : '<div class="muted" style="padding:12px;text-align:center">База знаний пока пуста — статьи появятся из ваших вопросов.</div>'}`;
    }
    const articles = kbSearch(kbArticles, query);
    const guides = kbSearchGuides(GUIDES, query);
    const nothing = !articles.length && !guides.length;
    if (nothing && query !== kbLastMissLogged) {
      kbLastMissLogged = query;
      api('/api/kb/miss', { method: 'POST', body: JSON.stringify({ query }) }).catch(() => {});
    }
    return `${articles.map(item => kbArticleCard(item.article)).join('')}
      ${guides.length ? `<div class="hd-top"><small class="muted">В инструкциях «?»:</small></div>
        ${guides.map(item => `<div class="hd-card"><b>${escapeHtml(item.guide.title)}</b>
          <small class="muted">откройте кнопку «?» в шапке — раздел «${escapeHtml(item.guide.title)}»</small></div>`).join('')}` : ''}
      ${nothing ? `<div class="hd-card"><b>Ответа пока нет</b>
        <small class="muted">Вопрос записан — база знаний пополнится. Если дело срочное или это не вопрос, а проблема — оформите заявку:</small>
        <div class="hd-actions"><button class="button small" id="kbToHelpdesk">🛟 Оформить заявкой</button></div>
      </div>` : ''}`;
  };

  function renderKb() {
    list.innerHTML = '<div class="muted" style="padding:12px;text-align:center">Загрузка базы знаний…</div>';
    api('/api/kb').then(payload => {
      if (active?.key !== 'kb') return;
      // Пока грузили, успели открыть форму статьи — не затираем её.
      if (list.querySelector('#kbForm')) return;
      kbArticles = payload.items || [];
      kbMisses = payload.misses || [];
      list.innerHTML = `<div class="hd-top">
          <input id="kbSearch" class="block-search" placeholder="Спросите по-своему: «как создать заявку», «перецеп», «простой»…" autocomplete="off">
          ${canDecide ? `<div class="hd-actions"><button class="button ghost small" id="kbNew">📚 Новая статья</button>
            ${kbMisses.length ? `<button class="button ghost small" id="kbMissesBtn" title="Что спрашивали и не нашли — сырьё для статей">🕳 Без ответа: ${kbMisses.length}</button>` : ''}</div>` : ''}
        </div>
        <div id="kbResults">${kbResultsHtml('')}</div>`;
      const results = list.querySelector('#kbResults');
      const wireResults = () => {
        results.querySelectorAll('[data-kb-vote]').forEach(button =>
          button.addEventListener('click', async () => {
            try {
              await api(`/api/kb/${button.dataset.kbId}/vote`,
                { method: 'POST', body: JSON.stringify({ helped: Boolean(button.dataset.kbVote) }) });
              kbVoted[button.dataset.kbId] = 1;
              localStorage.setItem('pl_kb_voted', JSON.stringify(kbVoted));
              toast('Спасибо — оценка учтена');
              const article = kbArticles.find(item => item.id === button.dataset.kbId);
              if (article) article[button.dataset.kbVote ? 'helped' : 'not_helped'] += 1;
              results.innerHTML = kbResultsHtml(list.querySelector('#kbSearch').value);
              wireResults();
            } catch (error) { toast(error.message, 'error'); }
          }));
        results.querySelectorAll('[data-kb-edit]').forEach(button =>
          button.addEventListener('click', () => {
            const article = kbArticles.find(item => item.id === button.dataset.kbEdit);
            if (article) kbFormView(article, article.id);
          }));
        const toHelpdesk = results.querySelector('#kbToHelpdesk');
        if (toHelpdesk) {
          toHelpdesk.onclick = () => {
            const query = list.querySelector('#kbSearch').value.trim();
            openRoom('helpdesk');
            hdFormView();
            const form = list.querySelector('#hdForm');
            if (form && query) form.problem.value = query;
          };
        }
      };
      wireResults();
      let timer = null;
      list.querySelector('#kbSearch').addEventListener('input', event => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          results.innerHTML = kbResultsHtml(event.target.value);
          wireResults();
        }, 350);
      });
      const newButton = list.querySelector('#kbNew');
      if (newButton) newButton.onclick = () => kbFormView();
      const missesButton = list.querySelector('#kbMissesBtn');
      if (missesButton) {
        missesButton.onclick = () => {
          results.innerHTML = `<div class="hd-top"><small class="muted">Спрашивали и не нашли (14 дней) — готовые темы для статей:</small></div>
            ${kbMisses.map(miss => `<div class="hd-card"><b>${escapeHtml(miss.query)}</b>
              <small class="muted">${escapeHtml(miss.user_name)} · ${formatDateTime(String(miss.created_at).replace(' ', 'T') + 'Z')}</small></div>`).join('')}`;
        };
      }
    }).catch(error => {
      list.innerHTML = `<div class="muted" style="padding:12px;text-align:center">${escapeHtml(error.message)}</div>`;
    });
  }

  const renderDialog = () => {
    if (!active) return;
    if (active.key === 'kb') {
      el('chatDialogTitle').textContent = roomTitle('kb');
      el('chatDialogSub').textContent = 'ответы из базы знаний и инструкций · вопрос без ответа станет статьёй';
      el('chatGroupEdit').classList.add('hidden');
      el('chatDelete').classList.add('hidden');
      el('chatForm').classList.add('hidden');
      // Щит ввода: открытые поиск/форма переживают фоновый поллинг чата.
      if (list.querySelector('#kbSearch') || list.querySelector('#kbForm')) return;
      renderKb();
      return;
    }
    if (active.key === 'tz') {
      el('chatDialogTitle').textContent = roomTitle('tz');
      el('chatDialogSub').textContent = 'видят руководители · решение за руководителем направления';
      el('chatGroupEdit').classList.add('hidden');
      el('chatDelete').classList.add('hidden');
      el('chatForm').classList.add('hidden');
      if (list.querySelector('#hdForm')) return;
      renderTz();
      return;
    }
    if (active.key === 'helpdesk') {
      el('chatDialogTitle').textContent = roomTitle('helpdesk');
      el('chatDialogSub').textContent = 'заявки видят все сотрудники · решение за руководителем';
      el('chatGroupEdit').classList.add('hidden');
      el('chatDelete').classList.add('hidden');
      el('chatForm').classList.add('hidden');
      // Щит ввода: открытая форма заявки переживает фоновый поллинг чата —
      // перерисовка списка заявок подождёт, пока форму отправят или закроют.
      if (list.querySelector('#hdForm')) return;
      renderHelpdesk();
      return;
    }
    const messages = allMessages.filter(m => roomKeyOf(m) === active.key);
    list.innerHTML = messages.map(bubble).join('')
      || '<div class="muted" style="padding:12px;text-align:center">Сообщений пока нет — напишите первое.</div>';
    list.scrollTop = list.scrollHeight;
    el('chatDialogTitle').textContent = roomTitle(active.key);
    const sub = active.key === 'all' ? 'все сотрудники'
      : active.key === 'personal' ? '🔒 личные отчёты планера — видите только вы'
      : active.key === 'auto' ? `уведомления по ролям: ${myRoles.map(role => ROLE_LABELS[role] || role).join(', ')}`
      : active.key.startsWith('dm:') ? '🔒 личная переписка — видите только вы двое'
      : (() => {
        const group = groups.find(item => item.id === active.key.slice(6));
        return group ? group.members.map(member => shortName(member.name)).join(', ') : '';
      })();
    el('chatDialogSub').textContent = typingNames.length
      ? `✏️ ${typingNames.join(', ')} печатает…` : sub;
    el('chatDialogSub').dataset.sub = sub;
    refreshRoomButtons();
    const group = active.key.startsWith('group:')
      ? groups.find(item => item.id === active.key.slice(6)) : null;
    el('chatGroupEdit').classList.toggle('hidden',
      !group || (group.created_by !== myId && !myRoles.includes('admin')));
    // 🗑: личную переписку скрывает у себя каждый; группу удаляет
    // создатель или админ; «Общий» и «Конвейер» не удаляются.
    const deletable = active.key.startsWith('dm:')
      || (group && (group.created_by === myId || myRoles.includes('admin')));
    el('chatDelete').classList.toggle('hidden', !deletable);
    // В «Конвейер» и личную ленту планера не пишут — это ленты процесса.
    el('chatForm').classList.toggle('hidden', active.key === 'auto' || active.key === 'personal');
    input.placeholder = active.key === 'all' ? 'Сообщение всем…'
      : active.key.startsWith('dm:') ? `Лично: ${shortName(roomTitle(active.key))}…` : 'Сообщение группе…';
  };

  // Живые мелочи открытой переписки («печатает…», ✓✓) — без перерисовки ленты.
  const renderDialogLive = () => {
    if (!active) return;
    const subNode = el('chatDialogSub');
    if (subNode.dataset.sub !== undefined) {
      subNode.textContent = typingNames.length
        ? `✏️ ${typingNames.join(', ')} печатает…` : subNode.dataset.sub;
    }
    if (active.key.startsWith('dm:') && peerReadId !== null) {
      list.querySelectorAll('.chat-bubble-row.own .chat-ticks').forEach(node => {
        const row = node.closest('[data-msg-id]');
        const id = Number(row?.dataset.msgId || 0);
        if (id && id <= peerReadId) node.textContent = '✓✓';
      });
    }
  };

  const showHome = () => {
    el('chatSearchWrap').classList.remove('hidden');
    active = null;
    el('chatHomeHead').classList.remove('hidden');
    el('chatDialogHead').classList.add('hidden');
    rooms.classList.remove('hidden');
    list.classList.add('hidden');
    el('chatForm').classList.add('hidden');
    el('chatCompose').classList.add('hidden');
    el('chatCompose').innerHTML = '';
    renderRooms();
    updateUnread();
  };

  function openRoom(key) {
    el('chatSearchWrap').classList.add('hidden');
    active = { key };
    peerReadId = null;
    typingNames = [];
    composing = { replyTo: null, editing: null };
    renderReplyBar();
    el('chatHomeHead').classList.add('hidden');
    el('chatDialogHead').classList.remove('hidden');
    rooms.classList.add('hidden');
    el('chatCompose').classList.add('hidden');
    el('chatCompose').innerHTML = '';
    list.classList.remove('hidden');
    el('chatForm').classList.remove('hidden');
    markSeen();
    renderDialog();
    if (!['auto', 'helpdesk', 'tz', 'kb', 'personal'].includes(key)) input.focus();
  }

  // «Прочитано» — только у открытой переписки.
  let lastSentRead = {};
  function markSeen() {
    if (!isOpen() || !active) return;
    seen[active.key] = lastId;
    saveSeen();
    updateUnread();
    // Серверная отметка (галочки ✓✓ у собеседника) — не чаще раза на id.
    if (!['auto', 'helpdesk', 'tz', 'kb', 'personal'].includes(active.key)
      && lastSentRead[active.key] !== lastId) {
      lastSentRead[active.key] = lastId;
      api('/api/chat/read', { method: 'POST',
        body: JSON.stringify({ roomKey: active.key, lastId }) }).catch(() => {});
    }
  }

  const updateUnread = () => {
    const total = roomList().reduce((sum, { key }) => sum + unreadOf(key), 0);
    unreadBadge.textContent = total;
    unreadBadge.classList.toggle('hidden', total === 0);
    toggle.classList.toggle('has-unread', total > 0);
    // Бейджи навигатора (12.11): мессенджер — непрочитанные, АРМ — задачи.
    state.navBadges = state.navBadges || {};
    state.navBadges.messenger = total;
    state.refreshNavBadges?.();
  };

  // ── Новый диалог или группа ──
  // Один принцип: управляющие элементы (название, кнопка создания, поиск)
  // закреплены сверху и видны всегда, прокручивается только список людей.
  const composeView = () => {
    rooms.classList.add('hidden');
    const box = el('chatCompose');
    box.classList.remove('hidden');
    box.innerHTML = `<div class="cmp-wrap">
      <div class="cmp-head">
        <button class="button small" id="cmpDm">🔒 Лично</button>
        <button class="button ghost small" id="cmpGroup">👥 Группа</button>
        <button class="button ghost small" id="cmpCancel" style="margin-left:auto">Отмена</button>
      </div>
      <div class="cmp-fixed" id="cmpFixed"></div>
      <div class="cmp-list" id="cmpBody"></div>
    </div>`;
    const fixed = box.querySelector('#cmpFixed');
    const body = box.querySelector('#cmpBody');
    const dmButton = box.querySelector('#cmpDm');
    const groupButton = box.querySelector('#cmpGroup');
    const markTab = isDm => {
      dmButton.className = isDm ? 'button small' : 'button ghost small';
      groupButton.className = isDm ? 'button ghost small' : 'button small';
    };
    const wireSearch = () => {
      fixed.querySelector('#cmpSearch').oninput = event => {
        const query = event.target.value.toLowerCase();
        body.querySelectorAll('.chat-room').forEach(row =>
          row.classList.toggle('hidden', !row.textContent.toLowerCase().includes(query)));
      };
    };
    // Личное сообщение: клик по сотруднику сразу открывает диалог.
    const dmView = () => {
      markTab(true);
      fixed.innerHTML = `<input id="cmpSearch" class="block-search"
        placeholder="Кому написать: поиск по имени…" style="width:100%">`;
      body.innerHTML = contacts.map(item =>
        `<div class="chat-room" data-dm="${item.id}"><span class="chat-ava human">${initials(item.full_name)}</span>
          <span class="chat-room-body"><b>${escapeHtml(item.full_name)}</b>
            <small class="muted" style="display:block">${(item.roles || []).map(role => ROLE_LABELS[role] || role).join(', ')}</small></span>
        </div>`).join('');
      wireSearch();
      body.querySelectorAll('[data-dm]').forEach(row =>
        row.addEventListener('click', () => openRoom(`dm:${row.dataset.dm}`)));
    };
    // Группа: название и кнопка «Создать» всегда наверху, на кнопке — счётчик.
    const groupView = (group = null) => {
      markTab(false);
      const memberIds = new Set(group ? group.members.map(member => member.id) : []);
      fixed.innerHTML = `<input id="cmpTitle" maxlength="60" style="width:100%"
          placeholder="Название группы (например: Смена А)" value="${group ? escapeHtml(group.title) : ''}">
        <button class="button" id="cmpCreate" style="width:100%;margin:6px 0">
          ${group ? 'Сохранить группу' : 'Создать группу'} <span id="cmpCount"></span></button>
        <input id="cmpSearch" class="block-search" placeholder="Отметьте участников: поиск…"
          style="width:100%">`;
      body.innerHTML = contacts.map(item =>
        `<label class="chat-room" data-member><input type="checkbox" value="${item.id}"
            ${memberIds.has(item.id) ? 'checked' : ''}>
          <span class="chat-ava human">${initials(item.full_name)}</span>
          <span class="chat-room-body"><b>${escapeHtml(item.full_name)}</b></span>
        </label>`).join('');
      wireSearch();
      const countBadge = fixed.querySelector('#cmpCount');
      const refreshCount = () => {
        const count = body.querySelectorAll('input:checked').length;
        countBadge.textContent = count ? `(вы + ${count})` : '(отметьте участников ↓)';
      };
      refreshCount();
      body.querySelectorAll('input[type=checkbox]').forEach(item =>
        item.addEventListener('change', refreshCount));
      fixed.querySelector('#cmpCreate').onclick = async () => {
        const title = fixed.querySelector('#cmpTitle').value.trim();
        const ids = [...body.querySelectorAll('input:checked')].map(item => item.value);
        if (!title) { toast('Укажите название группы', 'error'); fixed.querySelector('#cmpTitle').focus(); return; }
        if (!ids.length) { toast('Отметьте хотя бы одного участника галочкой', 'error'); return; }
        try {
          if (group) {
            await api(`/api/chats/${group.id}`, { method: 'PATCH',
              body: JSON.stringify({ title, memberIds: ids }) });
            await loadGroups();
            openRoom(`group:${group.id}`);
          } else {
            const created = await api('/api/chats', { method: 'POST',
              body: JSON.stringify({ title, memberIds: ids }) });
            await loadGroups();
            await poll();
            toast(`Группа «${title}» создана`);
            openRoom(`group:${created.id}`);
          }
        } catch (error) { toast(error.message, 'error'); }
      };
    };
    dmButton.onclick = dmView;
    groupButton.onclick = () => groupView();
    box.querySelector('#cmpCancel').onclick = showHome;
    dmView();
    return { groupView, box };
  };

  const refreshRoomButtons = () => {
    if (!active) return;
    const pref = prefOf(active.key);
    el('chatPin').textContent = pref.pinned ? '📍' : '📌';
    el('chatPin').title = pref.pinned ? 'Открепить' : 'Закрепить переписку сверху списка';
    el('chatMuteRoom').textContent = pref.muted ? '🔕' : '🔔';
    el('chatMuteRoom').title = pref.muted ? 'Включить уведомления переписки'
      : 'Без звука и всплывающих — счётчик остаётся';
    const service = ['auto', 'personal', 'helpdesk', 'tz', 'kb'].includes(active.key);
    el('chatPin').classList.toggle('hidden', service);
    el('chatMuteRoom').classList.toggle('hidden', ['helpdesk', 'tz', 'kb'].includes(active.key));
  };
  const togglePref = async field => {
    if (!active) return;
    const pref = prefOf(active.key);
    const next = { pinned: Boolean(pref.pinned), muted: Boolean(pref.muted) };
    next[field] = !next[field];
    try {
      await api('/api/chat/prefs', { method: 'POST',
        body: JSON.stringify({ roomKey: active.key, ...next }) });
      const norm = normKey(active.key);
      prefs = prefs.filter(item => item.room_key !== norm);
      prefs.push({ room_key: norm, pinned: next.pinned ? 1 : 0, muted: next.muted ? 1 : 0 });
      refreshRoomButtons();
      toast(field === 'pinned' ? (next.pinned ? 'Закреплено' : 'Откреплено')
        : (next.muted ? 'Переписка без звука' : 'Уведомления включены'));
    } catch (error) { toast(error.message, 'error'); }
  };
  el('chatPin').onclick = () => togglePref('pinned');
  el('chatMuteRoom').onclick = () => togglePref('muted');

  el('chatDelete').onclick = async () => {
    if (!active) return;
    if (active.key.startsWith('dm:')) {
      if (!confirm(`Скрыть переписку с «${roomTitle(active.key)}» из вашего списка?\n\n` +
        'История сохранится: переписка вернётся при новом сообщении ' +
        'или если снова открыть её через «✚ → Лично».')) return;
      try {
        await api('/api/chat/hide', { method: 'POST',
          body: JSON.stringify({ roomKey: active.key }) });
        hiddenRooms = hiddenRooms.filter(item => item.room_key !== active.key);
        hiddenRooms.push({ room_key: active.key, hidden_after: lastId });
        toast('Переписка скрыта');
        showHome();
      } catch (error) { toast(error.message, 'error'); }
      return;
    }
    if (active.key.startsWith('group:')) {
      const group = groups.find(item => item.id === active.key.slice(6));
      if (!group) return;
      if (!confirm(`Удалить группу «${group.title}» у всех участников?\n\n` +
        'История сохранится; восстановить группу сможет только администратор ' +
        '(🗄 Корзина внизу списка чатов).')) return;
      try {
        await api(`/api/chats/${group.id}`, { method: 'DELETE' });
        toast('Группа удалена; восстановление — через администратора');
        await loadGroups();
        showHome();
      } catch (error) { toast(error.message, 'error'); }
    }
  };
  el('chatNew').onclick = () => { armAudio(); composeView(); };
  el('chatGroupEdit').onclick = () => {
    const group = groups.find(item => item.id === active?.key?.slice(6));
    if (!group) return;
    el('chatHomeHead').classList.remove('hidden');
    el('chatDialogHead').classList.add('hidden');
    list.classList.add('hidden');
    el('chatForm').classList.add('hidden');
    composeView().groupView(group);
  };

  // ── Поллинг ──
  const poll = async (initial = false) => {
    try {
      const activeKey = active && !['helpdesk', 'tz', 'kb'].includes(active.key) ? active.key : '';
      const { items, lastId: serverLast, changed: changedRows, serverNow, myOpenTasks,
        typing, peerReadId: peerRead } =
        await api(`/api/messages?after=${initial ? 0 : lastId}${pollSince && !initial
          ? `&since=${encodeURIComponent(pollSince)}` : ''}${activeKey
          ? `&room=${encodeURIComponent(activeKey)}` : ''}`);
      // «Печатает…» и прочитанность собеседника — для открытой переписки.
      const typingText = (typing || []).join(', ');
      const newPeerRead = peerRead === undefined ? null : peerRead;
      const liveChanged = typingText !== typingNames.join(', ') || newPeerRead !== peerReadId;
      typingNames = typing || [];
      if (peerRead !== undefined) peerReadId = peerRead;
      if (liveChanged && active) renderDialogLive();
      if (serverNow) pollSince = serverNow;
      if (myOpenTasks !== undefined) {
        state.navBadges = state.navBadges || {};
        state.navBadges.arm = myOpenTasks;
      }
      let changed = initial;
      // Правки и удаления коллег: заменяем сообщения на месте (id прежний).
      for (const row of changedRows || []) {
        const index = allMessages.findIndex(m => m.id === row.id);
        if (index >= 0 && JSON.stringify(allMessages[index]) !== JSON.stringify(row)) {
          allMessages[index] = row;
          changed = true;
        }
      }
      for (const message of items) {
        if (allMessages.some(m => m.id === message.id)) continue;
        allMessages.push(message);
        changed = true;
        const key = roomKeyOf(message);
        const isNew = !initial && message.id > (seen[key] || 0);
        const own = message.author_id === myId;
        if (!isNew || own) continue;
        const inThisRoom = isOpen() && active?.key === key;
        const targeted = key.startsWith('dm:') || (message.kind === 'auto' && forMe(message))
          || key.startsWith('group:');
        if (!inThisRoom && !prefOf(key).muted) {
          const title = key.startsWith('dm:') ? `🔒 ${message.author_name}`
            : key.startsWith('group:') ? roomTitle(key)
            : message.kind === 'auto' ? '⚙ Конвейер' : `📢 ${message.author_name}`;
          if (targeted) {
            toast(`${title}: ${message.text}`.slice(0, 160));
            beep('target');
          } else {
            beep('other');
          }
          desktopNotify(`Пегас-Авто · ${title.replace(/^[📢⚙🔒👥] ?/, '')}`, message.text);
        }
      }
      allMessages.sort((a, b) => a.id - b.id);
      lastId = Math.max(lastId, serverLast);
      if (freshStart) {
        freshStart = false;
        for (const { key } of roomList()) seen[key] = lastId;
        saveSeen();
      }
      localStorage.setItem('pl_chat_last', String(lastId));
      if (changed) {
        if (active) { markSeen(); renderDialog(); } else if (isOpen()) renderRooms();
      }
      updateUnread();
    } catch { /* сеть/сессия — попробуем в следующий цикл */ }
  };

  const loadGroups = async () => {
    try {
      const payload = await api('/api/chats');
      groups = payload.items;
      hiddenRooms = payload.hidden || [];
      deletedGroups = payload.deleted || [];
      prefs = payload.prefs || [];
    } catch { /* не критично */ }
  };
  const loadContacts = async () => {
    try { contacts = (await api('/api/chat/users')).items; } catch { /* не критично */ }
  };

  // ── Управление панелью ──
  toggle.onclick = () => {
    armAudio();
    panel.classList.toggle('hidden');
    if (isOpen()) {
      if (active) { markSeen(); renderDialog(); } else showHome();
    }
  };
  el('chatClose').onclick = () => panel.classList.add('hidden');
  el('chatBack').onclick = showHome;
  const muteButton = el('chatMute');
  muteButton.onclick = () => {
    armAudio();
    soundSettings.muted = !soundSettings.muted;
    muteButton.textContent = soundSettings.muted ? '🔕' : '🔔';
    saveSound();
    if (!soundSettings.muted) beep('target');
  };
  el('chatVolume').oninput = event => {
    armAudio();
    soundSettings.volume = Number(event.target.value) / 100;
    if (soundSettings.volume > 0 && soundSettings.muted) {
      soundSettings.muted = false;
      muteButton.textContent = '🔔';
    }
    saveSound();
    beep('target');
  };
  // Переключатель системных всплывающих уведомлений (разрешение браузера).
  const desktopButton = el('chatDesktop');
  desktopButton.onclick = async () => {
    if (localStorage.getItem('pl_chat_desktop') === '1') {
      localStorage.setItem('pl_chat_desktop', '');
      desktopButton.textContent = '🚫🖥';
      toast('Всплывающие уведомления выключены');
      return;
    }
    if (typeof Notification === 'undefined') { toast('Браузер не поддерживает уведомления', 'error'); return; }
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') { toast('Разрешите уведомления в браузере', 'error'); return; }
    localStorage.setItem('pl_chat_desktop', '1');
    desktopButton.textContent = '🖥';
    desktopNotify('Пегас-Авто', 'Всплывающие уведомления включены ✅');
    toast('Всплывающие уведомления включены');
  };
  // 📎 вложение: файл грузится сразу, плашка видна до отправки сообщения.
  el('chatAttach').onclick = () => el('chatFile').click();
  el('chatFile').onchange = async () => {
    const file = el('chatFile').files[0];
    el('chatFile').value = '';
    if (!file || !active) return;
    if (file.size > 50 * 1024 * 1024) { toast('Файл больше 50 МБ', 'error'); return; }
    el('chatAttach').disabled = true;
    el('chatAttach').textContent = '⏳';
    try {
      const uploaded = await fetch('/api/chat-media', { method: 'POST',
        headers: { 'x-file-name': encodeURIComponent(file.name) }, body: file })
        .then(async r => { if (!r.ok) throw new Error((await r.json()).error || 'Не загрузилось'); return r.json(); });
      pendingMedia = uploaded;
      renderReplyBar();
      input.focus();
    } catch (error) { toast(error.message, 'error'); }
    el('chatAttach').disabled = false;
    el('chatAttach').textContent = '📎';
  };

  // @упоминание: набрали @ — список людей, клик вставляет @Имя_Фамилия.
  const mentionsBox = el('chatMentions');
  const renderMentionHints = () => {
    const value = input.value;
    const caretWord = /(^|\s)@([\wа-яёА-ЯЁ.]*)$/.exec(value.slice(0, input.selectionStart ?? value.length));
    if (!caretWord || !active || ['auto', 'personal', 'helpdesk', 'tz', 'kb'].includes(active.key)) {
      mentionsBox.classList.add('hidden');
      mentionsBox.innerHTML = '';
      return;
    }
    const query = caretWord[2].toLowerCase().replace(/_/g, ' ');
    const found = contacts.filter(person =>
      person.full_name.toLowerCase().includes(query)).slice(0, 6);
    if (!found.length) { mentionsBox.classList.add('hidden'); return; }
    mentionsBox.classList.remove('hidden');
    mentionsBox.innerHTML = found.map(person =>
      `<button type="button" class="chat-mention-opt" data-mention="${escapeHtml(person.full_name)}">
        ${escapeHtml(person.full_name)}</button>`).join('');
    mentionsBox.querySelectorAll('[data-mention]').forEach(button =>
      button.addEventListener('click', () => {
        const name = button.dataset.mention.replace(/\s+/g, '_');
        input.value = value.slice(0, input.selectionStart ?? value.length)
          .replace(/@([\wа-яёА-ЯЁ.]*)$/, `@${name} `) + value.slice(input.selectionStart ?? value.length);
        mentionsBox.classList.add('hidden');
        input.focus();
      }));
  };

  let typingSentAt = 0;
  input.addEventListener('input', () => {
    renderMentionHints();
    if (!active || ['auto', 'personal', 'helpdesk', 'tz', 'kb'].includes(active.key)) return;
    if (Date.now() - typingSentAt < 4000 || !input.value.trim()) return;
    typingSentAt = Date.now();
    api('/api/chat/typing', { method: 'POST',
      body: JSON.stringify({ roomKey: active.key }) }).catch(() => {});
  });

  el('chatForm').onsubmit = async event => {
    event.preventDefault();
    const text = input.value.trim();
    if ((!text && !pendingMedia) || !active || active.key === 'auto') return;
    try {
      if (composing.editing) {
        // Правка существующего: PATCH, пузырь обновляется на месте.
        const target = composing.editing;
        await api(`/api/messages/${target.id}`, { method: 'PATCH',
          body: JSON.stringify({ text }) });
        target.text = text;
        target.updated_at = new Date().toISOString();
      } else {
        const payload = { text };
        if (active.key.startsWith('dm:')) payload.recipientId = active.key.slice(3);
        if (active.key.startsWith('group:')) payload.chatId = active.key.slice(6);
        if (composing.replyTo) payload.replyToId = composing.replyTo.id;
        if (pendingMedia) { payload.mediaId = pendingMedia.id; payload.mediaName = pendingMedia.name; }
        // @упоминания: совпадение @Имя_Фамилия с людьми из справочника.
        const mentions = contacts.filter(person =>
          text.includes(`@${person.full_name.replace(/\s+/g, '_')}`)).map(person => person.id);
        if (mentions.length) payload.mentions = mentions;
        await api('/api/messages', { method: 'POST', body: JSON.stringify(payload) });
      }
      input.value = '';
      pendingMedia = null;
      composing = { replyTo: null, editing: null };
      renderReplyBar();
      await poll();
      renderDialog();
    } catch (error) { toast(error.message, 'error'); }
  };
  // Жест в любом месте страницы активирует звук уведомлений.
  document.addEventListener('click', armAudio, { once: true });

  // ── Полноэкранный режим «💬 Мессенджер» (вкладка в «Общем», 12.11) ──
  // Та же панель и логика: узел переезжает в контейнер вкладки и обратно.
  pageControls = {
    mount(container) {
      pendingPageContainer = null;
      container.appendChild(panel);
      panel.classList.add('chat-page');
      panel.classList.remove('hidden');
      el('chatClose').classList.add('hidden');
      if (active) { markSeen(); renderDialog(); }
      renderRooms();
      updateUnread();
    },
    unmount() {
      pendingPageContainer = null;
      if (!panel.classList.contains('chat-page')) return;
      panel.classList.remove('chat-page');
      panel.classList.add('hidden');
      el('chatClose').classList.remove('hidden');
      document.body.appendChild(panel);
    }
  };

  // Вкладка мессенджера ждала панель с момента загрузки страницы.
  if (pendingPageContainer && document.contains(pendingPageContainer)) {
    pageControls.mount(pendingPageContainer);
  }
  Promise.all([loadContacts(), loadGroups()]).then(() => poll(true));
  setInterval(poll, POLL_MS);
  // Группы (создание/удаление/восстановление коллегами) — раз в минуту.
  setInterval(async () => {
    await loadGroups();
    if (isOpen() && !active) renderRooms();
    // Открытая переписка удалённой группы закрывается сама.
    if (active?.key?.startsWith('group:') && !groups.some(g => g.id === active.key.slice(6))) {
      toast('Группа удалена администратором или создателем');
      showHome();
    }
  }, 60_000);

  // Версия интерфейса: после деплоя открытые вкладки узнают об обновлении.
  let knownVersion = null;
  const checkVersion = async () => {
    try {
      const health = await (await fetch('/api/health')).json();
      if (!health.assetVersion) return;
      if (knownVersion === null) { knownVersion = health.assetVersion; return; }
      if (health.assetVersion !== knownVersion) {
        knownVersion = health.assetVersion;
        // Табло в ТВ-режиме обновляется само (решение руководителя 02.11):
        // у телевизора некому жать «Обновить сейчас», и экран висел на
        // старой версии до ночного рестарта. ТВ-режим переживает
        // перезагрузку (pl_dash_tv) и сам вернётся в ротацию; несохранённого
        // ввода на табло нет. Рабочие места — по-прежнему баннером.
        let tv = false;
        try { tv = localStorage.getItem('pl_dash_tv') === '1'; } catch { /* ок */ }
        if (tv) { location.reload(); return; }
        showUpdateBanner();
      }
    } catch { /* сеть моргнула — проверим в следующий раз */ }
  };
  checkVersion();
  // Раз в минуту: на старой версии кнопки шлют устаревшие запросы, и работа
  // встаёт («программа не даёт провести») — узнавать об обновлении надо быстро.
  setInterval(checkVersion, 60_000);
}

// Баннер обновления — вместо всплывающей подсказки, которую легко пропустить:
// висит поверх интерфейса, пока страницу не перезагрузят.
function showUpdateBanner() {
  if (document.getElementById('updateBanner')) return;
  const banner = document.createElement('div');
  banner.id = 'updateBanner';
  banner.className = 'update-banner';
  banner.innerHTML = `<span>🔄 Вышло обновление планера. Обновите страницу —
    до этого часть кнопок работает по-старому.</span>
    <button class="button small" id="updateBannerGo">Обновить сейчас</button>
    <button class="button ghost small" id="updateBannerLater" title="Скрыть на 10 минут">Позже</button>`;
  document.body.appendChild(banner);
  document.getElementById('updateBannerGo').onclick = () => location.reload();
  document.getElementById('updateBannerLater').onclick = () => {
    banner.remove();
    setTimeout(showUpdateBanner, 10 * 60_000);
  };
}
