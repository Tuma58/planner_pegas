// Объявления на табло: общий экран в офисе показывает дашборд, и админу
// нужен способ вывести на него сообщение — планёрка, сбой 1С, аврал по
// простоям. Объявление живёт до своего срока и снимается само: висящая
// вторые сутки надпись перестаёт читаться и мешает цифрам.
//
// Доезжает без участия человека: активные объявления лежат в bootstrap,
// который табло и так перезапрашивает автообновлением, — экран подхватит
// новое сообщение за минуту, подходить к нему не надо.
import { api, escapeHtml, formatDateTime, toast } from './api.js';

const KIND_LABEL = { info: '🔵 Информация', warn: '🟡 Внимание', urgent: '🔴 Срочно' };

// Готовые формулировки: набраны из реальных поводов включить табло —
// чтобы объявление занимало секунды, а не сочинялось на ходу.
const TEMPLATES = [
  { text: 'Планёрка в 15:00 в переговорной', kind: 'info', hours: 8 },
  { text: 'Сбой 1С — заявки вносим в планер, в 1С проведём позже', kind: 'warn', hours: 4 },
  { text: 'Закрываем простои: свободные машины — в работу до конца дня', kind: 'warn', hours: 8 },
  { text: 'Приёмка документов до 17:00, позже — завтра', kind: 'info', hours: 6 }
];

const SLIDE_MS = 12_000;

// Срок «до отмены» показываем словами: на экране должно быть понятно,
// что объявление снимут руками, а не оно зависло.
function untilLabel(note) {
  return note.ends_at ? `до ${formatDateTime(note.ends_at)}` : 'до отмены';
}

export function boardNotesHtml(notes) {
  if (!notes?.length) return '';
  return `<div class="board-strip" data-board-strip>
    ${notes.map((note, index) => `<div class="board-note ${note.kind} ${index === 0 ? 'on' : ''}">
      <div class="board-text">${escapeHtml(note.text)}</div>
      ${note.subtext ? `<div class="board-sub">${escapeHtml(note.subtext)}</div>` : ''}
      <div class="board-meta">${escapeHtml(note.created_by_name || '')} · ${untilLabel(note)}</div>
    </div>`).join('')}
    ${notes.length > 1 ? `<div class="board-dots">${notes.map((note, index) =>
    `<i class="${index === 0 ? 'on' : ''}"></i>`).join('')}</div>` : ''}
  </div>`;
}

// Несколько объявлений сменяют друг друга: одновременно на экране одно —
// крупное и читаемое, а не четыре мелких.
export function wireBoardNotes(container, state) {
  clearInterval(state.boardTimer);
  const strip = container.querySelector('[data-board-strip]');
  const notes = strip ? [...strip.querySelectorAll('.board-note')] : [];
  if (notes.length < 2) return;
  const dots = [...strip.querySelectorAll('.board-dots i')];
  let current = 0;
  state.boardTimer = setInterval(() => {
    if (!document.body.contains(strip)) { clearInterval(state.boardTimer); return; }
    notes[current].classList.remove('on');
    dots[current]?.classList.remove('on');
    current = (current + 1) % notes.length;
    notes[current].classList.add('on');
    dots[current]?.classList.add('on');
  }, SLIDE_MS);
}

// Окно админа: публикация и снятие. Список активных здесь же — снять
// объявление должно быть так же быстро, как вывесить.
export function boardDialog(context) {
  const notes = context.state.data.boardNotes || [];
  context.showModal(`<h2>📢 Объявление на табло</h2>
    <p class="muted">Появится на общем экране в течение минуты — поверх дашборда, крупно.
      Снимется само по сроку.</p>
    <form id="boardForm">
      <label>Текст <small class="muted">до 240 знаков, крупная строка</small>
        <textarea name="text" rows="2" maxlength="240" required
          placeholder="Планёрка в 15:00 в переговорной"></textarea></label>
      <label>Вторая строка <small class="muted">необязательно: детали, ответственный</small>
        <input name="subtext" maxlength="160" placeholder="Логисты и диспетчеры — обязательно"></label>
      <div class="row2">
        <label>Тип
          <select name="kind">
            <option value="info">🔵 Информация</option>
            <option value="warn">🟡 Внимание</option>
            <option value="urgent">🔴 Срочно</option>
          </select></label>
        <label>Показывать
          <select name="hours">
            <option value="1">1 час</option>
            <option value="4">4 часа</option>
            <option value="8" selected>до конца смены (8 ч)</option>
            <option value="24">сутки</option>
            <option value="0">до отмены</option>
          </select></label>
      </div>
      <div class="board-templates">
        <small class="muted">Готовые:</small>
        ${TEMPLATES.map((item, index) => `<button type="button" class="button ghost small"
          data-board-tpl="${index}">${escapeHtml(item.text.slice(0, 34))}…</button>`).join('')}
      </div>
      <div class="modal-actions">
        <button type="button" class="button ghost" data-close>Отмена</button>
        <button class="button" type="submit">📢 Вывести на табло</button>
      </div>
    </form>
    <div class="scolh" style="margin-top:10px">Сейчас на табло <span>${notes.length}</span></div>
    <div class="list">${notes.length ? notes.map(note => `<div class="list-item ordrow">
      <span style="flex:1;min-width:0">
        <strong>${escapeHtml(note.text.slice(0, 70))}</strong>
        <small class="muted" style="display:block">${KIND_LABEL[note.kind] || note.kind}
          · ${untilLabel(note)} · ${escapeHtml(note.created_by_name || '')}</small>
      </span>
      <button class="button ghost small" data-board-remove="${note.id}">✕ Снять</button>
    </div>`).join('') : '<p class="muted">Табло чистое — объявлений нет.</p>'}</div>`);

  const form = document.getElementById('boardForm');
  form.querySelectorAll('[data-board-tpl]').forEach(button =>
    button.addEventListener('click', () => {
      const template = TEMPLATES[Number(button.dataset.boardTpl)];
      form.text.value = template.text;
      form.kind.value = template.kind;
      form.hours.value = String(template.hours);
      form.text.focus();
    }));
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const body = {
      text: form.text.value.trim(), subtext: form.subtext.value.trim(),
      kind: form.kind.value, hours: Number(form.hours.value)
    };
    if (!body.text) return;
    try {
      await api('/api/board-notes', { method: 'POST', body: JSON.stringify(body) });
      toast('Объявление на табло');
      context.closeModal();
      context.onReload();
    } catch (error) { toast(error.message, true); }
  });
  document.querySelectorAll('[data-board-remove]').forEach(button =>
    button.addEventListener('click', async () => {
      try {
        await api(`/api/board-notes/${button.dataset.boardRemove}`, { method: 'DELETE' });
        toast('Объявление снято');
        context.closeModal();
        context.onReload();
      } catch (error) { toast(error.message, true); }
    }));
}
