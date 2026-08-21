// Внутренний чат и уведомления конвейера.
// Общий канал для всех сотрудников + личные переписки один на один
// (видят только отправитель и получатель) + авто-сообщения «Конвейера»,
// адресованные роли следующего участника процесса: адресату они приходят
// тостом со звуком. Вкладки-чипы: «Общий» и диалоги с непрочитанными.
// Поллинг лёгкий (raw JSON раз в 20 секунд), новизна — по id сообщения.
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

// Локальные настройки звука чата: живут в браузере этого рабочего места,
// не зависят от системной громкости устройства.
const soundSettings = {
  muted: localStorage.getItem('pl_chat_muted') === '1',
  volume: Math.min(1, Math.max(0, Number(localStorage.getItem('pl_chat_volume') ?? 0.5)))
};
function saveSound() {
  localStorage.setItem('pl_chat_muted', soundSettings.muted ? '1' : '');
  localStorage.setItem('pl_chat_volume', String(soundSettings.volume));
}

// Сигналы без аудиофайлов: «вам задание» — двухтональный, обычное
// оповещение — одиночный тихий тон. Громкость — программная (ползунок).
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

export function setupChat(state) {
  const toolbarEnd = document.querySelector('.toolbar-end');
  if (!toolbarEnd || document.getElementById('chatToggle')) return;
  const toggle = document.createElement('button');
  toggle.id = 'chatToggle';
  toggle.className = 'button ghost small';
  toggle.title = 'Внутренний чат и уведомления конвейера';
  toggle.innerHTML = '💬 <span class="chat-unread hidden" id="chatUnread">0</span>';
  toolbarEnd.prepend(toggle);

  const panel = document.createElement('aside');
  panel.className = 'chat-panel hidden';
  panel.innerHTML = `<div class="chat-head"><strong>Чат · конвейер</strong>
      <span class="chat-sound" title="Звук уведомлений этого рабочего места — не зависит от громкости устройства">
        <button class="button ghost small" id="chatMute"
          title="Выключить/включить звук уведомлений">${soundSettings.muted ? '🔕' : '🔔'}</button>
        <input type="range" id="chatVolume" min="0" max="100" step="5"
          value="${Math.round(soundSettings.volume * 100)}" title="Громкость уведомлений">
      </span>
      <button class="button ghost small" id="chatClose">✕</button></div>
    <div class="chat-tabs" id="chatTabs"></div>
    <div class="chat-list" id="chatList"></div>
    <form class="chat-form" id="chatForm">
      <input id="chatInput" placeholder="Сообщение всем…" autocomplete="off" maxlength="500">
      <button class="button small">➤</button>
    </form>`;
  document.body.appendChild(panel);

  const myRoles = state.data.user.roles || [state.data.user.role];
  const myId = state.data.user.id;
  let lastId = Number(localStorage.getItem('pl_chat_last') || 0);
  let seenId = Number(localStorage.getItem('pl_chat_seen') || 0);
  let unread = 0;
  const list = panel.querySelector('#chatList');
  const tabsBox = panel.querySelector('#chatTabs');
  const input = panel.querySelector('#chatInput');
  const unreadBadge = document.getElementById('chatUnread');
  const isOpen = () => !panel.classList.contains('hidden');
  const forMe = message => message.target_role && myRoles.includes(message.target_role);

  // Личные переписки: активная вкладка (null — общий канал), сообщения в
  // памяти, справочник собеседников, отметки «прочитано» по каждому диалогу.
  let activePeer = null;
  const allMessages = [];
  let contacts = [];
  let dmSeen = {};
  try { dmSeen = JSON.parse(localStorage.getItem('pl_chat_dm_seen') || '{}') || {}; } catch { dmSeen = {}; }
  const saveDmSeen = () => localStorage.setItem('pl_chat_dm_seen', JSON.stringify(dmSeen));
  const peerName = id => contacts.find(item => item.id === id)?.full_name
    || allMessages.find(m => m.author_id === id && m.author_name)?.author_name || 'Сотрудник';
  const shortName = full => {
    const [last, first] = String(full).split(' ');
    return first ? `${last} ${first[0]}.` : last;
  };
  const inDialog = (message, peer) => message.recipient_id &&
    ((message.author_id === myId && message.recipient_id === peer) ||
     (message.author_id === peer && message.recipient_id === myId));
  const onTab = message => activePeer ? inDialog(message, activePeer) : !message.recipient_id;
  const dmUnreadOf = peer => allMessages.filter(m =>
    m.author_id === peer && m.recipient_id === myId && m.id > (dmSeen[peer] || 0)).length;
  // Диалоги: с кем есть переписка, непрочитанные — первыми.
  const dialogPeers = () => {
    const ids = new Set();
    for (const m of allMessages) {
      if (!m.recipient_id) continue;
      if (m.author_id === myId) ids.add(m.recipient_id);
      else if (m.recipient_id === myId) ids.add(m.author_id);
    }
    return [...ids].sort((a, b) => dmUnreadOf(b) - dmUnreadOf(a)
      || peerName(a).localeCompare(peerName(b), 'ru'));
  };

  const renderTabs = () => {
    const chips = [`<button type="button" class="chat-tab ${activePeer ? '' : 'on'}" data-peer="">
        Общий${unread ? ` <span class="chat-unread">${unread}</span>` : ''}</button>`];
    for (const peer of dialogPeers()) {
      const count = dmUnreadOf(peer);
      chips.push(`<button type="button" class="chat-tab ${activePeer === peer ? 'on' : ''}"
        data-peer="${peer}" title="Личная переписка: видите только вы двое">
        ${escapeHtml(shortName(peerName(peer)))}${count ? ` <span class="chat-unread">${count}</span>` : ''}</button>`);
    }
    chips.push(`<select id="chatNewPeer" title="Написать сотруднику лично">
      <option value="">✎ Написать…</option>
      ${contacts.filter(item => item.id !== activePeer).map(item =>
        `<option value="${item.id}">${escapeHtml(item.full_name)}</option>`).join('')}</select>`);
    tabsBox.innerHTML = chips.join('');
    tabsBox.querySelectorAll('.chat-tab').forEach(tab =>
      tab.addEventListener('click', () => openTab(tab.dataset.peer || null)));
    tabsBox.querySelector('#chatNewPeer').onchange = event => {
      if (event.target.value) openTab(event.target.value);
    };
  };

  const renderList = () => {
    list.innerHTML = allMessages.filter(onTab).map(renderMessage).join('')
      || `<div class="muted" style="padding:10px">${activePeer
        ? 'Переписка пока пуста — напишите первое сообщение.' : ''}</div>`;
    list.scrollTop = list.scrollHeight;
    input.placeholder = activePeer ? `Лично: ${shortName(peerName(activePeer))}…` : 'Сообщение всем…';
  };

  function openTab(peer) {
    activePeer = peer;
    markSeen();
    renderTabs();
    renderList();
    input.focus();
  }

  // «Прочитано» — только для открытой вкладки: общий канал и каждый диалог
  // помечаются независимо, чтобы личное не «прочитывалось» вслепую.
  function markSeen() {
    if (!isOpen()) return;
    if (activePeer) {
      dmSeen[activePeer] = lastId;
      saveDmSeen();
    } else {
      seenId = lastId;
      localStorage.setItem('pl_chat_seen', String(seenId));
      unread = 0;
    }
    updateUnread();
  }

  const renderMessage = message => `<div class="chat-msg ${message.kind} ${forMe(message) ? 'mine-target' : ''} ${message.recipient_id ? 'dm' : ''} ${message.author_id === myId ? 'own' : ''}">
      <small class="muted">${message.kind === 'auto'
        ? `⚙ Конвейер${message.target_role ? ` → ${ROLE_LABELS[message.target_role] || message.target_role}` : ''}`
        : escapeHtml(message.author_name)}${message.recipient_id ? ' · 🔒 лично' : ''} · ${formatDateTime(message.created_at.includes('Z')
          ? message.created_at : message.created_at.replace(' ', 'T') + 'Z')}</small>
      <div>${escapeHtml(message.text)}</div>
    </div>`;

  const updateUnread = () => {
    const total = unread + dialogPeers().reduce((sum, peer) => sum + dmUnreadOf(peer), 0);
    unreadBadge.textContent = total;
    unreadBadge.classList.toggle('hidden', total === 0);
  };

  const poll = async (initial = false) => {
    try {
      const { items, lastId: serverLast } = await api(`/api/messages?after=${initial ? 0 : lastId}`);
      let changed = initial;
      for (const message of items) {
        if (message.id <= lastId && !initial) continue;
        allMessages.push(message);
        changed = true;
        const isNew = message.id > seenId && !initial;
        const ownMessage = message.author_id === myId;
        // Общий канал: счётчик как раньше; личное мне — тост и двойной сигнал.
        if (message.recipient_id) {
          if (isNew && message.recipient_id === myId &&
              !(isOpen() && activePeer === message.author_id)) {
            toast(`🔒 ${message.author_name}: ${message.text}`);
            beep('target');
          }
        } else {
          if (isNew && !isOpen()) unread += 1;
          if (isNew && forMe(message)) {
            toast(message.text);
            beep('target');
          } else if (isNew && !ownMessage) {
            beep('other');
          }
        }
      }
      lastId = Math.max(lastId, serverLast);
      localStorage.setItem('pl_chat_last', String(lastId));
      markSeen();
      if (changed) {
        renderTabs();
        renderList();
      }
      updateUnread();
    } catch { /* сеть/сессия — попробуем в следующий цикл */ }
  };

  // Справочник собеседников — один раз при старте (список сотрудников).
  const loadContacts = async () => {
    try { contacts = (await api('/api/chat/users')).items; renderTabs(); } catch { /* не критично */ }
  };

  toggle.onclick = () => {
    armAudio();
    panel.classList.toggle('hidden');
    if (isOpen()) {
      markSeen();
      renderTabs();
      renderList();
      input.focus();
    }
  };
  panel.querySelector('#chatClose').onclick = () => panel.classList.add('hidden');
  const muteButton = panel.querySelector('#chatMute');
  muteButton.onclick = () => {
    armAudio();
    soundSettings.muted = !soundSettings.muted;
    muteButton.textContent = soundSettings.muted ? '🔕' : '🔔';
    saveSound();
    if (!soundSettings.muted) beep('target');
  };
  panel.querySelector('#chatVolume').oninput = event => {
    armAudio();
    soundSettings.volume = Number(event.target.value) / 100;
    if (soundSettings.volume > 0 && soundSettings.muted) {
      soundSettings.muted = false;
      muteButton.textContent = '🔔';
    }
    saveSound();
    beep('target');
  };
  panel.querySelector('#chatForm').onsubmit = async event => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    try {
      await api('/api/messages', { method: 'POST',
        body: JSON.stringify({ text, recipientId: activePeer || undefined }) });
      input.value = '';
      await poll();
    } catch (error) { toast(error.message, 'error'); }
  };
  // Жест в любом месте страницы активирует звук уведомлений.
  document.addEventListener('click', armAudio, { once: true });

  poll(true);
  loadContacts();
  setInterval(poll, POLL_MS);

  // Версия интерфейса: после деплоя открытые вкладки узнают об обновлении
  // (иначе сотрудники работают на старом JS до перезагрузки страницы).
  let knownVersion = null;
  const checkVersion = async () => {
    try {
      const health = await (await fetch('/api/health')).json();
      if (!health.assetVersion) return;
      if (knownVersion === null) { knownVersion = health.assetVersion; return; }
      if (health.assetVersion !== knownVersion) {
        knownVersion = health.assetVersion;
        toast('Вышло обновление планера — обновите страницу (Ctrl+R)', 'error');
      }
    } catch { /* сеть моргнула — проверим в следующий раз */ }
  };
  checkVersion();
  setInterval(checkVersion, 5 * 60_000);
}
