// Заявки на доработку — общий интерфейс двух лент одной механики:
// 🛟 HELP DESK (сотрудники, комната чата, 02.11) и 📐 Тех. задание
// (руководители дорабатывают новый продукт, плашка в АРМ, 10.11).
// Карточка, форма-каркас ТЗ из пяти полей, вложение, статусы
// руководителя с личным ответом автору — одни и те же; различаются
// только вид заявки (kind) и тексты.
import { api, escapeHtml, formatDateTime, toast } from './api.js';

export const TICKET_STATUS = {
  new: ['🆕 новая', 'hd-new'], review: ['👀 на рассмотрении', 'hd-review'],
  work: ['🔧 в работе', 'hd-work'], done: ['✅ готово', 'hd-done'],
  rejected: ['✖ отклонена', 'hd-rejected']
};

export const TICKET_TEXT = {
  helpdesk: {
    newButton: '✍ Новая заявка', formTitle: '✍ Новая заявка', send: '📨 Отправить заявку',
    intro: 'Опишите, что мешает в работе планера, — заявку увидят все, решение о выполнении примет руководитель.',
    empty: 'Заявок пока нет — опишите первую.',
    place: 'Где: экран или вкладка (например: Логист → карточка рейса)',
    problem: 'Что не так или чего не хватает — своими словами',
    sent: 'Заявка отправлена — руководитель получил уведомление',
    footer: 'Заявки рассматриваются раз в день; решение о выполнении принимает руководитель — ответ придёт вам в «📬 Планер — лично».'
  },
  tz: {
    newButton: '✍ Новое ТЗ', formTitle: '✍ Тех. задание на доработку', send: '📨 Отправить ТЗ',
    intro: 'Доработка нового продукта вместе с руководителями отделов: что изменить или добавить. ТЗ видят все руководители, решение — руководитель направления.',
    empty: 'ТЗ пока нет — опишите первое.',
    place: 'Где: экран, блок или процесс (например: АРМ → зона «План»; Ремзона → наряд)',
    problem: 'Что изменить или добавить — своими словами',
    sent: 'ТЗ отправлено — руководитель направления получил уведомление',
    footer: 'Решение по ТЗ принимает руководитель направления — ответ придёт вам в «📬 Планер — лично».'
  }
};

const shortName = full => {
  const [last, first] = String(full).split(' ');
  return first ? `${last} ${first[0]}.` : last;
};
const ticketTime = value => formatDateTime(String(value).includes('Z')
  ? value : String(value).replace(' ', 'T') + 'Z');
const DEPT_TITLE = { staff: 'Штаб', log: 'Логистика', drv: 'Эксплуатация', toir: 'ТОиР' };

export function ticketCard(ticket, { canDecide, kb = false }) {
  const [label, cls] = TICKET_STATUS[ticket.status] || TICKET_STATUS.new;
  const open = !['done', 'rejected'].includes(ticket.status);
  return `<div class="hd-card ${open ? '' : 'hd-closed'}">
    <div class="hd-head"><span class="hd-status ${cls}">${label}</span>
      <b>${escapeHtml(shortName(ticket.author_name))}</b>
      ${ticket.dept ? `<span class="owner-chip chip-${escapeHtml(ticket.dept)}">${escapeHtml(DEPT_TITLE[ticket.dept] || ticket.dept)}</span>` : ''}
      <small class="muted">${ticketTime(ticket.created_at)}</small></div>
    ${ticket.place ? `<div><small class="muted">Где:</small> ${escapeHtml(ticket.place)}</div>` : ''}
    <div>${escapeHtml(ticket.problem)}</div>
    ${ticket.expected ? `<div><small class="muted">Как должно быть:</small> ${escapeHtml(ticket.expected)}</div>` : ''}
    ${ticket.frequency ? `<small class="muted">Частота: ${escapeHtml(ticket.frequency)}</small>` : ''}
    ${ticket.media_id ? `<a href="/api/helpdesk-media/${ticket.media_id}" target="_blank" rel="noopener">📎 Вложение — открыть</a>` : ''}
    ${ticket.decision_note ? `<div class="hd-note"><small class="muted">${escapeHtml(ticket.decided_by_name || 'Решение')}:</small>
      ${escapeHtml(ticket.decision_note)}</div>` : ''}
    ${canDecide && open ? `<div class="hd-actions">
      ${ticket.status === 'new' ? `<button class="button ghost small" data-hd-set="review" data-hd-id="${ticket.id}">👀 На рассмотрение</button>` : ''}
      ${ticket.status !== 'work' ? `<button class="button ghost small" data-hd-set="work" data-hd-id="${ticket.id}">🔧 В работу</button>` : ''}
      <button class="button ghost small" data-hd-set="done" data-hd-id="${ticket.id}">✅ Готово</button>
      <button class="button ghost small" data-hd-set="rejected" data-hd-id="${ticket.id}">✖ Отклонить</button>
    </div>` : ''}
    ${canDecide && !open && kb ? `<div class="hd-actions">
      <button class="button ghost small" data-hd-kb="${ticket.id}"
        title="Превратить вопрос и ответ заявки в статью базы знаний">📚 В статью</button>
    </div>` : ''}
  </div>`;
}

// Черновик формы: входящий звонок или перерисовка открывают своё окно
// поверх и сносят недописанное ТЗ (заявка Базуева 12.11) — введённое
// сохраняется на каждый ввод и восстанавливается при следующем открытии.
// Живёт сутки; чистится после успешной отправки.
const draftKey = kind => `hdDraft:${kind}`;
function loadDraft(kind) {
  try {
    const raw = JSON.parse(localStorage.getItem(draftKey(kind)) || 'null');
    if (!raw || Date.now() - (raw.ts || 0) > 86_400_000) return null;
    return (raw.place || raw.problem || raw.expected) ? raw : null;
  } catch { return null; }
}
function saveDraft(kind, form) {
  try {
    localStorage.setItem(draftKey(kind), JSON.stringify({
      ts: Date.now(), place: form.place.value, problem: form.problem.value,
      expected: form.expected.value, frequency: form.frequency.value
    }));
  } catch { /* приватное окно — некритично */ }
}
const clearDraft = kind => { try { localStorage.removeItem(draftKey(kind)); } catch { /* некритично */ } };

// Форма — каркас тех.задания из пяти полей; onDone — после отправки
// или отмены (перерисовать ленту).
export function ticketForm(list, { kind = 'helpdesk', onDone }) {
  const text = TICKET_TEXT[kind];
  const draft = loadDraft(kind);
  list.innerHTML = `<form class="hd-form" id="hdForm">
    <b>${text.formTitle}</b>
    ${draft ? '<small class="muted">↩ Черновик восстановлен — недописанное не пропало</small>' : ''}
    <input name="place" maxlength="120" placeholder="${escapeHtml(text.place)}" value="${escapeHtml(draft?.place || '')}">
    <textarea name="problem" rows="3" maxlength="1000" required placeholder="${escapeHtml(text.problem)}">${escapeHtml(draft?.problem || '')}</textarea>
    <textarea name="expected" rows="2" maxlength="1000" placeholder="Как должно быть (по-вашему)">${escapeHtml(draft?.expected || '')}</textarea>
    <select name="frequency">
      <option value="">Как часто мешает…</option>
      <option ${draft?.frequency === 'мешает каждый день' ? 'selected' : ''}>мешает каждый день</option>
      <option ${draft?.frequency === 'несколько раз в неделю' ? 'selected' : ''}>несколько раз в неделю</option>
      <option ${draft?.frequency === 'иногда' ? 'selected' : ''}>иногда</option>
      <option ${draft?.frequency === 'случилось один раз' ? 'selected' : ''}>случилось один раз</option>
    </select>
    <label><small class="muted">Скриншот, запись экрана, текст или таблица (по желанию)</small>
      <input type="file" name="media" accept=".png,.jpg,.jpeg,.webp,.gif,.mp4,.webm,.mov,.md,.txt,.csv,.xlsx,.xls"></label>
    <div class="hd-actions">
      <button class="button small" type="submit">${text.send}</button>
      <button class="button ghost small" type="button" id="hdCancel">Отмена</button>
    </div>
    <small class="muted">${escapeHtml(text.footer)}</small>
  </form>`;
  // «Отмена» — осознанный отказ: черновик чистится; снос формы извне
  // (звонок, перерисовка) черновик не трогает — он и спасает текст.
  list.querySelector('#hdCancel').onclick = () => { clearDraft(kind); onDone?.(); };
  list.querySelector('#hdForm').oninput = event => saveDraft(kind, event.currentTarget);
  list.querySelector('#hdForm').onsubmit = async event => {
    event.preventDefault();
    const form = event.target;
    const body = {
      kind, place: form.place.value.trim(), problem: form.problem.value.trim(),
      expected: form.expected.value.trim(), frequency: form.frequency.value
    };
    const file = form.media.files[0];
    const submitButton = form.querySelector('button[type=submit]');
    try {
      submitButton.disabled = true;
      if (file) {
        submitButton.textContent = '⏳ Загрузка файла…';
        const upload = await fetch('/api/helpdesk-media', {
          method: 'POST',
          headers: { 'X-File-Name': encodeURIComponent(file.name) },
          body: file
        });
        const uploaded = await upload.json().catch(() => ({}));
        if (!upload.ok) throw new Error(uploaded.error || 'Не удалось загрузить файл');
        body.mediaId = uploaded.id;
        body.mediaName = file.name;
      }
      await api('/api/helpdesk', { method: 'POST', body: JSON.stringify(body) });
      clearDraft(kind);
      toast(text.sent);
      onDone?.();
    } catch (error) {
      toast(error.message, 'error');
      submitButton.disabled = false;
      submitButton.textContent = text.send;
    }
  };
}

// Лента заявок вида kind в контейнере list: шапка «новое», карточки,
// статусы руководителя. stillHere() — пользователь не ушёл, пока грузили.
export async function mountTickets(list, { kind = 'helpdesk', canDecide = false, kb = false,
  stillHere = () => true, onKb, onChange } = {}) {
  const text = TICKET_TEXT[kind];
  const rerender = () => mountTickets(list, { kind, canDecide, kb, stillHere, onKb, onChange });
  list.innerHTML = '<div class="muted" style="padding:12px;text-align:center">Загрузка…</div>';
  let items = [];
  try { items = (await api(`/api/helpdesk?kind=${kind}`)).items; } catch (error) {
    list.innerHTML = `<div class="muted" style="padding:12px;text-align:center">${escapeHtml(error.message)}</div>`;
    return;
  }
  if (!stillHere()) return;
  list.innerHTML = `<div class="hd-top">
      <button class="button small" id="hdNew">${text.newButton}</button>
      <small class="muted">${escapeHtml(text.intro)}</small>
    </div>
    ${items.map(ticket => ticketCard(ticket, { canDecide, kb })).join('')
      || `<div class="muted" style="padding:12px;text-align:center">${escapeHtml(text.empty)}</div>`}`;
  list.scrollTop = 0;
  list.querySelector('#hdNew').onclick = () => ticketForm(list, { kind, onDone: () => { rerender(); onChange?.(); } });
  list.querySelectorAll('[data-hd-set]').forEach(button =>
    button.addEventListener('click', async () => {
      const status = button.dataset.hdSet;
      let note = '';
      if (status === 'rejected') {
        note = (prompt('Причина отклонения — автор увидит её в ответе:') || '').trim();
        if (!note) return;
      } else if (status === 'done') {
        note = (prompt('Комментарий к выполнению (можно пусто):') || '').trim();
      }
      try {
        await api(`/api/helpdesk/${button.dataset.hdId}/status`,
          { method: 'POST', body: JSON.stringify({ status, note }) });
        toast('Статус обновлён — автор получил уведомление');
        rerender();
        onChange?.();
      } catch (error) { toast(error.message, 'error'); }
    }));
  list.querySelectorAll('[data-hd-kb]').forEach(button =>
    button.addEventListener('click', () => {
      const ticket = items.find(item => item.id === button.dataset.hdKb);
      if (ticket) onKb?.(ticket);
    }));
}
