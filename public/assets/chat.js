// Внутренний чат в стиле Telegram: список переписок с последним сообщением
// и счётчиками непрочитанных → лента-пузыри выбранной переписки.
// Виды переписок: «Общий» (все сотрудники), «⚙ Конвейер» (авто-уведомления
// процесса, каждому по его ролям — личная лента заданий), личные диалоги
// (видят только двое) и группы (создаются любым сотрудником, видят участники).
// Всплывающие системные уведомления браузера — включаются кнопкой 🖥 и
// работают, даже когда планер в фоновой вкладке. Поллинг raw JSON раз в 20 с.
import { api, escapeHtml, formatDateTime, toast } from './api.js';

const POLL_MS = 20_000;
const ROLE_LABELS = {
  logist: 'Логист', dispatcher: 'Диспетчер', sales: 'Продажи',
  accountant: 'Бухгалтерия', resource: 'Ресурс', manager: 'Руководитель', admin: 'Администратор'
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

export function setupChat(state) {
  const toolbarEnd = document.querySelector('.toolbar-end');
  if (!toolbarEnd || document.getElementById('chatToggle')) return;
  const toggle = document.createElement('button');
  toggle.id = 'chatToggle';
  toggle.className = 'button small chat-toggle';
  toggle.title = 'Внутренний чат: общий канал, лента конвейера, личные и группы';
  toggle.innerHTML = '💬 Чат <span class="chat-unread hidden" id="chatUnread">0</span>';
  toolbarEnd.prepend(toggle);

  const myRoles = state.data.user.roles || [state.data.user.role];
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
      <button class="button ghost small hidden" id="chatGroupEdit" title="Состав и название группы">⚙</button>
      <button class="button ghost small hidden" id="chatDelete" title="Удалить переписку">🗑</button>
    </div>
    <div class="chat-rooms" id="chatRooms"></div>
    <div class="chat-list hidden" id="chatList"></div>
    <div class="chat-compose hidden" id="chatCompose"></div>
    <form class="chat-form hidden" id="chatForm">
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
    // Персональные авто-уведомления (утренний отчёт всем) — в ленте «⚙ Конвейер».
    if (message.kind === 'auto') return 'auto';
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
    if (key.startsWith('dm:')) return peerName(key.slice(3));
    const group = groups.find(item => item.id === key.slice(6));
    return group ? `👥 ${group.title}` : '👥 Группа';
  };
  const unreadOf = key => allMessages.filter(m => roomKeyOf(m) === key &&
    m.id > (seen[key] || 0) && m.author_id !== myId).length;

  // Список переписок: закреплённые «Общий» и «Конвейер», затем диалоги и
  // группы по времени последнего сообщения (как в Telegram).
  const roomList = () => {
    const keys = new Set(['all', 'auto']);
    for (const message of allMessages) keys.add(roomKeyOf(message));
    for (const group of groups) keys.add(`group:${group.id}`);
    const lastMsg = {};
    for (const message of allMessages) {
      const key = roomKeyOf(message);
      if (!lastMsg[key] || message.id > lastMsg[key].id) lastMsg[key] = message;
    }
    const pinned = ['all', 'auto'];
    const rest = [...keys].filter(key => !pinned.includes(key))
      .filter(key => {
        // Удалённая группа пропадает из списка сразу (сообщения в памяти не в счёт).
        if (key.startsWith('group:')) return groups.some(group => group.id === key.slice(6));
        const hidden = hiddenRooms.find(item => item.room_key === key);
        return !hidden || (lastMsg[key]?.id || 0) > hidden.hidden_after;
      })
      .sort((a, b) => (lastMsg[b]?.id || 0) - (lastMsg[a]?.id || 0));
    return [...pinned, ...rest].map(key => ({ key, last: lastMsg[key] || null }));
  };

  const renderRooms = () => {
    rooms.innerHTML = roomList().map(({ key, last }) => {
      const count = unreadOf(key);
      const title = roomTitle(key);
      const avatar = key === 'all' ? '📢' : key === 'auto' ? '⚙'
        : key.startsWith('group:') ? '👥' : initials(title);
      const time = last ? formatDateTime(last.created_at.includes('Z')
        ? last.created_at : last.created_at.replace(' ', 'T') + 'Z') : '';
      const preview = last
        ? `${last.author_id === myId ? 'Вы: ' : (key.startsWith('group:') || key === 'all')
            ? `${shortName(last.author_name || '⚙')}: ` : ''}${last.text}`
        : (key === 'auto' ? 'Уведомления процесса — по вашим ролям' : 'Сообщений пока нет');
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

  const bubble = message => {
    const own = message.author_id === myId;
    const auto = message.kind === 'auto';
    const groupish = active?.key === 'all' || active?.key?.startsWith('group:');
    return `<div class="chat-bubble-row ${own ? 'own' : ''}">
      <div class="chat-bubble ${own ? 'own' : ''} ${auto ? 'auto' : ''} ${forMe(message) ? 'mine-target' : ''}">
        ${!own && (groupish || auto) ? `<small class="chat-author">${auto
          ? `⚙ Конвейер${message.target_role ? ` → ${ROLE_LABELS[message.target_role] || message.target_role}` : ''}`
          : escapeHtml(message.author_name)}</small>` : ''}
        <div>${escapeHtml(message.text)}</div>
        <small class="chat-time">${formatDateTime(message.created_at.includes('Z')
          ? message.created_at : message.created_at.replace(' ', 'T') + 'Z')}
          <span class="chat-msg-actions">
            <button type="button" class="chat-act" data-copy-msg="${message.id}" title="Скопировать текст">📋</button>
            <button type="button" class="chat-act" data-forward-msg="${message.id}" title="Переслать в другую переписку">↪</button>
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

  // Делегированные действия на пузырях: копирование и пересылка.
  list.addEventListener('click', async event => {
    const copyButton = event.target.closest('[data-copy-msg]');
    if (copyButton) {
      const message = allMessages.find(m => m.id === Number(copyButton.dataset.copyMsg));
      if (message) { await copyText(message.text); toast('Сообщение скопировано'); }
      return;
    }
    const forwardButton = event.target.closest('[data-forward-msg]');
    if (forwardButton) {
      const message = allMessages.find(m => m.id === Number(forwardButton.dataset.forwardMsg));
      if (message) forwardView(message);
    }
  });

  const renderDialog = () => {
    if (!active) return;
    const messages = allMessages.filter(m => roomKeyOf(m) === active.key);
    list.innerHTML = messages.map(bubble).join('')
      || '<div class="muted" style="padding:12px;text-align:center">Сообщений пока нет — напишите первое.</div>';
    list.scrollTop = list.scrollHeight;
    el('chatDialogTitle').textContent = roomTitle(active.key);
    const sub = active.key === 'all' ? 'все сотрудники'
      : active.key === 'auto' ? `уведомления по ролям: ${myRoles.map(role => ROLE_LABELS[role] || role).join(', ')}`
      : active.key.startsWith('dm:') ? '🔒 личная переписка — видите только вы двое'
      : (() => {
        const group = groups.find(item => item.id === active.key.slice(6));
        return group ? group.members.map(member => shortName(member.name)).join(', ') : '';
      })();
    el('chatDialogSub').textContent = sub;
    const group = active.key.startsWith('group:')
      ? groups.find(item => item.id === active.key.slice(6)) : null;
    el('chatGroupEdit').classList.toggle('hidden',
      !group || (group.created_by !== myId && !myRoles.includes('admin')));
    // 🗑: личную переписку скрывает у себя каждый; группу удаляет
    // создатель или админ; «Общий» и «Конвейер» не удаляются.
    const deletable = active.key.startsWith('dm:')
      || (group && (group.created_by === myId || myRoles.includes('admin')));
    el('chatDelete').classList.toggle('hidden', !deletable);
    // В «Конвейер» не пишут — это лента процесса.
    el('chatForm').classList.toggle('hidden', active.key === 'auto');
    input.placeholder = active.key === 'all' ? 'Сообщение всем…'
      : active.key.startsWith('dm:') ? `Лично: ${shortName(roomTitle(active.key))}…` : 'Сообщение группе…';
  };

  const showHome = () => {
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
    active = { key };
    el('chatHomeHead').classList.add('hidden');
    el('chatDialogHead').classList.remove('hidden');
    rooms.classList.add('hidden');
    el('chatCompose').classList.add('hidden');
    el('chatCompose').innerHTML = '';
    list.classList.remove('hidden');
    el('chatForm').classList.remove('hidden');
    markSeen();
    renderDialog();
    if (key !== 'auto') input.focus();
  }

  // «Прочитано» — только у открытой переписки.
  function markSeen() {
    if (!isOpen() || !active) return;
    seen[active.key] = lastId;
    saveSeen();
    updateUnread();
  }

  const updateUnread = () => {
    const total = roomList().reduce((sum, { key }) => sum + unreadOf(key), 0);
    unreadBadge.textContent = total;
    unreadBadge.classList.toggle('hidden', total === 0);
    toggle.classList.toggle('has-unread', total > 0);
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
      const { items, lastId: serverLast } = await api(`/api/messages?after=${initial ? 0 : lastId}`);
      let changed = initial;
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
        if (!inThisRoom) {
          const title = key.startsWith('dm:') ? `🔒 ${message.author_name}`
            : key.startsWith('group:') ? roomTitle(key)
            : message.kind === 'auto' ? '⚙ Конвейер' : `📢 ${message.author_name}`;
          if (targeted) {
            toast(`${title}: ${message.text}`.slice(0, 160));
            beep('target');
          } else {
            beep('other');
          }
          desktopNotify(`PegasLogistic · ${title.replace(/^[📢⚙🔒👥] ?/, '')}`, message.text);
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
    desktopNotify('PegasLogistic', 'Всплывающие уведомления включены ✅');
    toast('Всплывающие уведомления включены');
  };
  el('chatForm').onsubmit = async event => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text || !active || active.key === 'auto') return;
    const payload = { text };
    if (active.key.startsWith('dm:')) payload.recipientId = active.key.slice(3);
    if (active.key.startsWith('group:')) payload.chatId = active.key.slice(6);
    try {
      await api('/api/messages', { method: 'POST', body: JSON.stringify(payload) });
      input.value = '';
      await poll();
    } catch (error) { toast(error.message, 'error'); }
  };
  // Жест в любом месте страницы активирует звук уведомлений.
  document.addEventListener('click', armAudio, { once: true });

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
