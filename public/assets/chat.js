// Внутренний чат и уведомления конвейера.
// Общий канал для всех сотрудников + авто-сообщения «Конвейера», адресованные
// роли следующего участника процесса: адресату они приходят тостом со звуком.
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

// Короткий двухтональный сигнал «вам задание» без аудиофайлов.
function beep() {
  if (!audioContext || audioContext.state === 'suspended') return;
  const now = audioContext.currentTime;
  [[880, 0], [660, 0.14]].forEach(([freq, offset]) => {
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.frequency.value = freq;
    gain.gain.setValueAtTime(0.001, now + offset);
    gain.gain.exponentialRampToValueAtTime(0.12, now + offset + 0.02);
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
      <button class="button ghost small" id="chatClose">✕</button></div>
    <div class="chat-list" id="chatList"></div>
    <form class="chat-form" id="chatForm">
      <input id="chatInput" placeholder="Сообщение всем…" autocomplete="off" maxlength="500">
      <button class="button small">➤</button>
    </form>`;
  document.body.appendChild(panel);

  const myRoles = state.data.user.roles || [state.data.user.role];
  let lastId = Number(localStorage.getItem('pl_chat_last') || 0);
  let seenId = Number(localStorage.getItem('pl_chat_seen') || 0);
  let unread = 0;
  const list = panel.querySelector('#chatList');
  const unreadBadge = document.getElementById('chatUnread');
  const isOpen = () => !panel.classList.contains('hidden');
  const forMe = message => message.target_role && myRoles.includes(message.target_role);

  const renderMessage = message => `<div class="chat-msg ${message.kind} ${forMe(message) ? 'mine-target' : ''}">
      <small class="muted">${message.kind === 'auto'
        ? `⚙ Конвейер${message.target_role ? ` → ${ROLE_LABELS[message.target_role] || message.target_role}` : ''}`
        : escapeHtml(message.author_name)} · ${formatDateTime(message.created_at.includes('Z')
          ? message.created_at : message.created_at.replace(' ', 'T') + 'Z')}</small>
      <div>${escapeHtml(message.text)}</div>
    </div>`;

  const updateUnread = () => {
    unreadBadge.textContent = unread;
    unreadBadge.classList.toggle('hidden', unread === 0);
  };

  const poll = async (initial = false) => {
    try {
      const { items, lastId: serverLast } = await api(`/api/messages?after=${initial ? 0 : lastId}`);
      if (initial) list.innerHTML = '';
      for (const message of items) {
        if (message.id <= lastId && !initial) continue;
        list.insertAdjacentHTML('beforeend', renderMessage(message));
        const isNew = message.id > seenId && !initial;
        if (isNew && !isOpen()) unread += 1;
        // Адресованное моей роли — тост со звуком, даже при закрытой панели.
        if (isNew && forMe(message)) {
          toast(message.text);
          beep();
        }
      }
      lastId = Math.max(lastId, serverLast);
      localStorage.setItem('pl_chat_last', String(lastId));
      if (isOpen()) {
        seenId = lastId;
        localStorage.setItem('pl_chat_seen', String(seenId));
        unread = 0;
        list.scrollTop = list.scrollHeight;
      }
      updateUnread();
    } catch { /* сеть/сессия — попробуем в следующий цикл */ }
  };

  toggle.onclick = () => {
    armAudio();
    panel.classList.toggle('hidden');
    if (isOpen()) {
      seenId = lastId;
      localStorage.setItem('pl_chat_seen', String(seenId));
      unread = 0;
      updateUnread();
      list.scrollTop = list.scrollHeight;
      panel.querySelector('#chatInput').focus();
    }
  };
  panel.querySelector('#chatClose').onclick = () => panel.classList.add('hidden');
  panel.querySelector('#chatForm').onsubmit = async event => {
    event.preventDefault();
    const input = panel.querySelector('#chatInput');
    const text = input.value.trim();
    if (!text) return;
    try {
      await api('/api/messages', { method: 'POST', body: JSON.stringify({ text }) });
      input.value = '';
      await poll();
    } catch (error) { toast(error.message, 'error'); }
  };
  // Жест в любом месте страницы активирует звук уведомлений.
  document.addEventListener('click', armAudio, { once: true });

  poll(true);
  setInterval(poll, POLL_MS);
}
