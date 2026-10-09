// Вкладка «Сотрудники» (решение руководителя 07.10): единый справочник
// офисных и водителей с должностями. Карточка офисного — по утверждённому
// макету (связь, доступ, график смен произвольного заполнения, история);
// карточка водителя — существующая (открывается из этого же списка).
// Доступ: staff:write (руководитель, админ) или логин из настройки
// «полный доступ» — сервер отдаёт готовый флаг user.staffAccess.
import { api, escapeHtml, renderInto, toast } from './api.js';

// Увольнение — всегда с причиной (решение руководителя 07.10): типовой
// классификатор + комментарий; собранная строка уходит в журнал и видна
// в истории карточки. Диалог общий для офисных и водителей.
export const FIRE_REASONS = ['По собственному желанию', 'Дисциплина (прогулы, нарушения)',
  'Не прошёл испытательный срок', 'Сокращение / реорганизация', 'Перевод', 'Иное'];

export function fireReasonDialog({ showModal, closeModal }, fullName, note, onConfirm) {
  showModal(`<form id="fireForm"><h2>Увольнение · ${escapeHtml(fullName)}</h2>
    ${note ? `<p class="muted">${escapeHtml(note)}</p>` : ''}
    <label class="field">Причина<select name="reason">${FIRE_REASONS.map(reason =>
    `<option>${reason}</option>`).join('')}</select></label>
    <label class="field">Комментарий <small class="muted">(обязателен при «Иное»)</small>
      <input name="comment" autocomplete="off"></label>
    <div class="form-error" id="fireFormError"></div>
    <div class="modal-actions"><button type="button" class="button ghost" data-close>Отмена</button>
      <button class="button danger">✕ Уволить</button></div></form>`);
  document.querySelector('#fireForm').addEventListener('submit', async event => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const reason = String(values.get('reason'));
    const comment = String(values.get('comment') || '').trim();
    const error = document.querySelector('#fireFormError');
    if (reason === 'Иное' && !comment) {
      error.textContent = 'При причине «Иное» комментарий обязателен';
      return;
    }
    try {
      await onConfirm(comment ? `${reason} — ${comment}` : reason);
      closeModal();
    } catch (exception) { error.textContent = exception.message; }
  });
}

const KIND_LABEL = { day: 'Д', night: 'Н', vacation: 'ОТ', sick: 'Б' };
const KIND_TITLE = { day: 'дневная смена', night: 'ночная смена', vacation: 'отпуск', sick: 'больничный' };

const monthIso = date => date.toISOString().slice(0, 7);
const fmtDate = value => value ? new Date(value).toLocaleDateString('ru-RU') : '—';
const fmtDateTime = value => value
  ? new Date(String(value).includes('T') ? value : value.replace(' ', 'T') + 'Z')
    .toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
  : '—';

export async function renderStaff(container, context) {
  const { state } = context;
  let payload;
  try {
    payload = await api('/api/staff');
  } catch (error) {
    container.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    return;
  }
  const query = (state.staffQuery || '').toLowerCase();
  const matches = person => !query ||
    `${person.fullName} ${person.jobRole} ${person.phone} ${person.extPhone || ''} ${person.username || ''} ${person.vehiclePlate || ''}`
      .toLowerCase().includes(query);
  const users = payload.users.filter(matches);
  const drivers = payload.drivers.filter(matches);
  const fired = users.filter(person => !person.active);
  // Секции-сегменты: офис и водители не теснят друг друга (замечание
  // руководителя 07.10); при живом поиске показываются обе — человека
  // ищут, не зная секции.
  const section = state.staffSection || 'office';
  const showOffice = query ? users.length > 0 : section === 'office';
  const showDrivers = query ? drivers.length > 0 : section === 'drivers';

  const userRow = person => `<tr class="${person.active ? '' : 'staff-fired'}">
    <td><span class="vlink" data-staff-card="${person.id}">${escapeHtml(person.fullName)}</span>
      ${person.guest ? '<small class="muted" style="display:block">гость (только чтение)</small>' : ''}</td>
    <td>${escapeHtml(person.jobRole || '—')}</td>
    <td class="mono">${escapeHtml(person.extPhone || '')}${person.extPhone && person.phone ? ' · ' : ''}${escapeHtml(person.phone || '')}
      ${person.workPhone ? `<small class="muted" title="телефон текущей смены (вводится при входе)" style="display:block">смена: ${escapeHtml(person.workPhone)}</small>` : ''}</td>
    <td>${person.telegram ? '✓' : '<span class="muted">—</span>'}</td>
    <td>${person.active ? '<span class="badge ok">работает</span>'
      : `<span class="badge warn" title="уволен ${fmtDate(person.firedAt)}">уволен</span>`}</td>
  </tr>`;
  const driverRow = person => `<tr>
    <td><span class="vlink" data-staff-driver="${person.id}">${escapeHtml(person.fullName)}</span></td>
    <td>Водитель${person.shift ? ` <small class="muted">вахта ${escapeHtml(person.shift)}</small>` : ''}</td>
    <td class="mono">${escapeHtml(person.phone || '—')}</td>
    <td>${escapeHtml(person.vehiclePlate || '—')}</td>
    <td><span class="badge ok">работает</span></td>
  </tr>`;

  const html = `<div class="resboard" id="staffBoard">
    <div class="section-head" style="align-items:center;gap:10px;flex-wrap:wrap">
      <h1 style="margin:0">Сотрудники</h1>
      <span class="staff-seg">
        <button data-staff-sec="office" class="${section === 'office' ? 'active' : ''}">Офис · ${payload.users.filter(person => person.active).length}</button>
        <button data-staff-sec="drivers" class="${section === 'drivers' ? 'active' : ''}">Водители · ${payload.drivers.length}</button>
      </span>
      <input id="staffSearch" class="block-search" placeholder="Поиск по всем: ФИО, должность, телефон, сцепка"
        value="${escapeHtml(state.staffQuery || '')}" style="flex:1;min-width:180px;max-width:360px">
      <button class="button small ghost" id="staffAts"
        title="Абоненты АТС Билайн: кто из сотрудников на каком добавочном; несопоставленные номера — привязать или оставить незадействованными">☎ Сверка с АТС</button>
      <button class="button small" id="staffAddUser">+ Сотрудник</button>
      <button class="button small ghost" id="staffAddDriver" title="Водители заводятся в справочнике «Водители» — там же сцепка и вахта">+ Водитель</button>
    </div>
    ${query && !users.length && !drivers.length ? '<p class="muted" style="margin-top:14px">Никого не найдено.</p>' : ''}
    ${showOffice ? `${query ? `<h3 style="margin:14px 0 6px">Офис · найдено ${users.length}</h3>` : ''}
    <div style="overflow:auto;margin-top:${query ? 0 : 12}px"><table class="rtable"><thead><tr>
      <th>Сотрудник</th><th>Должность</th><th>Телефоны</th><th>TG</th><th>Статус</th>
    </tr></thead><tbody>${users.map(userRow).join('') || '<tr><td colspan=5 class="muted">Никого не найдено</td></tr>'}</tbody></table></div>
    ${fired.length ? `<p class="muted" style="font-size:12px">Уволенные остаются в списке серыми — карточка и история доступны, восстановление из карточки.</p>` : ''}` : ''}
    ${showDrivers ? `${query ? `<h3 style="margin:14px 0 6px">Водители · найдено ${drivers.length}</h3>` : ''}
    <div style="overflow:auto;margin-top:${query ? 0 : 12}px"><table class="rtable"><thead><tr>
      <th>Водитель</th><th>Должность</th><th>Телефон</th><th>Сцепка</th><th>Статус</th>
    </tr></thead><tbody>${drivers.map(driverRow).join('') || '<tr><td colspan=5 class="muted">Никого не найдено</td></tr>'}</tbody></table></div>` : ''}
  </div>`;
  if (!renderInto(container, html)) return;

  container.querySelectorAll('[data-staff-sec]').forEach(button =>
    button.onclick = () => {
      state.staffSection = button.dataset.staffSec;
      renderStaff(container, context);
    });
  const search = container.querySelector('#staffSearch');
  search.addEventListener('input', () => {
    state.staffQuery = search.value;
    renderStaff(container, context);
  });
  container.querySelector('#staffAddUser').onclick = () => staffEditDialog(context, null,
    () => renderStaff(container, context));
  container.querySelector('#staffAts').onclick = () => staffAtsDialog(context,
    () => renderStaff(container, context));
  container.querySelector('#staffAddDriver').onclick = () => context.openDrivers?.();
  container.querySelectorAll('[data-staff-card]').forEach(element =>
    element.onclick = () => staffCardDialog(context, element.dataset.staffCard,
      () => renderStaff(container, context)));
  container.querySelectorAll('[data-staff-driver]').forEach(element =>
    element.onclick = () => context.openDriverCard?.(element.dataset.staffDriver));
}

// ── Сверка абонентов АТС со справочником (этап 2, 08.10) ──
// Экран для кадровика: добавочный · корпоративный мобильный · кто из
// сотрудников на нём. Несопоставленный номер привязывается выбором
// сотрудника; совпавшие по мобильному заполняются автоматически.
export async function staffAtsDialog(context, after) {
  const { showModal, closeModal } = context;
  let payload;
  try { payload = await api('/api/staff/ats'); } catch (error) { toast(error.message); return; }
  const items = payload.items || [];
  if (!items.length) {
    toast('Справочник АТС пуст — проверьте токен Билайна в настройках телефонии');
    return;
  }
  const mapped = items.filter(item => item.userId).length;
  const options = (context.state.data.user ? await api('/api/staff') : { users: [] }).users
    .filter(person => person.active)
    .map(person => `<option value="${person.id}">${escapeHtml(person.fullName)}${person.jobRole ? ` — ${escapeHtml(person.jobRole)}` : ''}</option>`)
    .join('');
  showModal(`<div>
    <h2>☎ Сверка с АТС Билайн</h2>
    <p class="muted" style="font-size:12.5px">Абонентов в АТС: ${items.length} ·
      сопоставлено с сотрудниками: <b>${mapped}</b> · незадействованных: ${items.length - mapped}.
      По сопоставленным карточка звонка всплывает адресату; в настройках телефонии
      можно включить «подписки только на сопоставленных».</p>
    <div style="overflow:auto;max-height:56vh"><table class="rtable"><thead><tr>
      <th>Добавочный</th><th>Моб. АТС</th><th>Сотрудник</th><th></th>
    </tr></thead><tbody>
      ${items.map(item => `<tr>
        <td class="mono"><b>${escapeHtml(String(item.ext))}</b></td>
        <td class="mono">${escapeHtml(item.phone || '—')}</td>
        <td>${item.userId
    ? `${escapeHtml(item.userName)} <small class="muted">${item.source === 'ext' ? '· из карточки' : '· по мобильному'}</small>`
    : '<span class="muted">не задействован</span>'}</td>
        <td>${item.userId ? '' : `<select data-ats-bind="${escapeHtml(String(item.ext))}" class="inline">
            <option value="">— привязать… —</option>${options}</select>`}</td>
      </tr>`).join('')}
    </tbody></table></div>
    <div class="modal-actions"><button type="button" class="button ghost" data-close>Закрыть</button></div>
  </div>`, 'staffcard');
  document.querySelectorAll('[data-ats-bind]').forEach(select =>
    select.onchange = async () => {
      if (!select.value) return;
      try {
        await api('/api/staff/ats/bind', { method: 'POST', body: JSON.stringify({
          ext: select.dataset.atsBind, userId: select.value }) });
        toast(`Добавочный ${select.dataset.atsBind} привязан`);
        closeModal();
        staffAtsDialog(context, after);
      } catch (error) { toast(error.message); }
    });
}

// ── Карточка офисного сотрудника (макет утверждён 07.10) ──
export async function staffCardDialog(context, id, after) {
  const { showModal, closeModal } = context;
  const month = context.state.staffCardMonth || monthIso(new Date());
  let card;
  try {
    card = await api(`/api/staff/users/${id}/card?month=${month}`);
  } catch (error) { toast(error.message); return; }
  const person = card.user;
  const reopen = () => staffCardDialog(context, id, after);

  const histRow = item => {
    let note = '';
    try {
      const details = JSON.parse(item.details_json || '{}');
      if (details.workPhone) note = ` · телефон смены ${details.workPhone}`;
      if (details.month) note = ` · ${details.month}: смен ${(details.day || 0) + (details.night || 0)}`;
      if (details.reason && item.action === 'fire') note = ` · ${details.reason}`;
    } catch { /* детали не обязательны */ }
    const labels = {
      login: 'вход в планер', create: 'принят(а), создана учётка', update: 'данные изменены',
      fire: 'увольнение', restore: 'восстановление', staff_shifts: 'график заполнен',
      guide_ack: 'ознакомление с инструкцией'
    };
    return `<div><span class="dt muted" style="margin-right:8px">${fmtDateTime(item.created_at)}</span>
      ${escapeHtml(labels[item.action] || `${item.action} ${item.entity}`)}${escapeHtml(note)}</div>`;
  };

  showModal(`<div id="staffCard">
    <div style="display:flex;flex-wrap:wrap;align-items:center;gap:8px">
      <h2 style="margin:0">${escapeHtml(person.fullName)}</h2>
      <span class="badge ok">${escapeHtml(person.jobRole || person.roleLabel)}</span>
      ${person.active ? '<span class="badge ok">🟢 работает</span>'
        : `<span class="badge warn">уволен(а) ${fmtDate(person.firedAt)}</span>`}
    </div>
    <p class="muted" style="margin:4px 0 12px;font-size:12.5px">
      в компании с ${fmtDate(person.hiredAt)} · учётка ${escapeHtml(person.username)}
      · последний вход ${fmtDateTime(person.lastLoginAt)}</p>
    ${(() => {
    // Чек-лист приёма (этап 4, 09.10): виден первые 30 дней, пока не
    // закрыты все пункты — ничего не забыть при вводе человека в строй.
    const hiredMs = Date.parse(String(person.hiredAt || '').slice(0, 10));
    const fresh = Number.isFinite(hiredMs) && Date.now() - hiredMs < 30 * 86_400_000;
    const items = [
      ['Учётка', true, ''],
      ['Личный телефон', Boolean(person.phone), '«✎ Данные» → личный мобильный'],
      ['Добавочный АТС', Boolean(person.extPhone), '«☎ Сверка с АТС» или «✎ Данные» — без него карточка звонка не найдёт адресата'],
      ['Telegram', Boolean(person.telegram), 'сотрудник привязывает бота сам — инструкция в «?» раздел «Общее»'],
      ['Инструкции', Boolean(person.guideAckAt), 'сотрудник читает «?» и жмёт «✍ Подтвердить ознакомление»'],
      ['График месяца', Object.keys(card.shifts || {}).length > 0, 'заполните смены пером ниже'],
      ['Первый вход', Boolean(person.lastLoginAt), 'выдайте логин и пароль — при входе укажет рабочий телефон']
    ];
    const open = items.filter(([, done]) => !done);
    if (!fresh || !open.length || !person.active) return '';
    return `<div style="background:var(--panel2,#f2f7f7);border-radius:10px;padding:10px 12px;margin-bottom:10px">
      <h3 style="margin:0 0 6px;font-size:12px;color:var(--muted,#5b7083)">🚀 ЧЕК-ЛИСТ ПРИЁМА · выполнено ${items.length - open.length}/${items.length}</h3>
      <div style="display:flex;flex-wrap:wrap;gap:6px">${items.map(([label, done, hint]) =>
    `<span class="badge ${done ? 'ok' : 'warn'}" title="${escapeHtml(hint)}">${done ? '✓' : '✗'} ${label}</span>`).join('')}</div>
      ${open.length ? `<div class="muted" style="font-size:11.5px;margin-top:5px">${open.map(([label, , hint]) => `<b>${label}</b>: ${escapeHtml(hint)}`).join(' · ')}</div>` : ''}
    </div>`;
  })()}
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px" class="staff-grid">
      <div class="sec" style="background:var(--panel2);border-radius:10px;padding:10px 12px">
        <h3 style="margin:0 0 6px;font-size:12px;color:var(--muted,#5b7083)">📞 СВЯЗЬ</h3>
        <div class="dash-row"><span>Добавочный АТС</span><b>${escapeHtml(person.extPhone || '—')}</b></div>
        <div class="dash-row"><span>Личный мобильный</span><b>${escapeHtml(person.phone || '—')}</b></div>
        <div class="dash-row"><span>Телефон смены</span><b>${escapeHtml(person.workPhone || '—')}</b></div>
        <div class="dash-row"><span>Telegram</span><b>${person.telegram ? '✓ привязан' : '—'}</b></div>
        <div class="dash-row"><span>E-mail</span><b>${escapeHtml(person.email || '—')}</b></div>
      </div>
      <div class="sec" style="background:var(--panel2);border-radius:10px;padding:10px 12px">
        <h3 style="margin:0 0 6px;font-size:12px;color:var(--muted,#5b7083)">🔐 ДОСТУП</h3>
        <div class="dash-row"><span>Роли в планере</span><b>${escapeHtml(person.roleLabel)}</b></div>
        <div class="dash-row"><span>Инструкции</span><b>${person.guideAckAt ? `✍ ${fmtDate(person.guideAckAt)}` : '—'}</b></div>
        <div class="dash-row"><span>Учётка</span><b>${person.active ? 'активна' : 'отключена'}${person.guest ? ' · гость' : ''}</b></div>
      </div>
    </div>
    <div style="background:var(--panel2);border-radius:10px;padding:10px 12px;margin-top:10px">
      <h3 style="margin:0 0 6px;font-size:12px;color:var(--muted,#5b7083)">📅 ГРАФИК —
        <button class="button ghost small" id="scMPrev">◀</button>
        <b id="scMonthLabel">${month}</b>
        <button class="button ghost small" id="scMNext">▶</button>
      </h3>
      <div class="staff-pen" id="scPen">
        <span class="muted" style="font-size:12px">Перо:</span>
        <button class="button small" data-pen="day">Д</button>
        <button class="button small" data-pen="night">Н</button>
        <button class="button small" data-pen="vacation">ОТ</button>
        <button class="button small" data-pen="sick">Б</button>
        <button class="button small ghost" data-pen="">стереть</button>
        <span class="muted" style="font-size:11.5px">— выберите перо и кликайте/протягивайте по дням</span>
      </div>
      <div class="staff-cal" id="scCal"></div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:6px">
        <span class="muted" style="font-size:12px" id="scSummary"></span>
        <button class="button small" id="scSave">💾 Сохранить график</button>
      </div>
    </div>
    <div style="background:var(--panel2);border-radius:10px;padding:10px 12px;margin-top:10px">
      <h3 style="margin:0 0 6px;font-size:12px;color:var(--muted,#5b7083)">🕘 ИСТОРИЯ</h3>
      <div style="font-size:12.5px;max-height:160px;overflow:auto">${card.history.map(histRow).join('') || '<span class="muted">пусто</span>'}</div>
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:12px">
      <button class="button" id="scEdit">✎ Данные</button>
      ${person.active
        ? '<button class="button ghost danger" id="scFire">✕ Уволить</button>'
        : '<button class="button ghost" id="scRestore">↩ Восстановить</button>'}
      <button class="button ghost" id="scClose" style="margin-left:auto">Закрыть</button>
    </div>
  </div>`, 'staffcard');

  // Календарь: произвольное заполнение выбранным пером, клик и протяжка.
  const days = { ...card.shifts };
  let pen = 'day';
  let dragging = false;
  const cal = document.querySelector('#scCal');
  const [year, mon] = month.split('-').map(Number);
  const total = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  const todayIso = new Date().toISOString().slice(0, 10);
  const WD = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
  const redraw = () => {
    cal.innerHTML = Array.from({ length: total }, (_, index) => {
      const iso = `${month}-${String(index + 1).padStart(2, '0')}`;
      const kind = days[iso] || '';
      const weekday = new Date(Date.UTC(year, mon - 1, index + 1)).getUTCDay();
      return `<button type="button" class="staff-day k-${kind || 'off'} ${iso === todayIso ? 'today' : ''} ${[0, 6].includes(weekday) ? 'we' : ''}"
        data-day="${iso}" title="${KIND_TITLE[kind] || 'выходной'}">
        <b>${index + 1}</b><small>${kind ? KIND_LABEL[kind] : WD[weekday]}</small></button>`;
    }).join('');
    const counts = Object.values(days).reduce((acc, kind) => (acc[kind] = (acc[kind] || 0) + 1, acc), {});
    document.querySelector('#scSummary').textContent =
      `смен ${(counts.day || 0) + (counts.night || 0)} (Д ${counts.day || 0} · Н ${counts.night || 0})`
      + (counts.vacation ? ` · отпуск ${counts.vacation}` : '')
      + (counts.sick ? ` · больничный ${counts.sick}` : '');
  };
  const paint = target => {
    const cell = target.closest?.('.staff-day');
    if (!cell) return;
    if (pen) days[cell.dataset.day] = pen; else delete days[cell.dataset.day];
    redraw();
  };
  cal.addEventListener('mousedown', event => { dragging = true; paint(event.target); event.preventDefault(); });
  cal.addEventListener('mouseover', event => { if (dragging) paint(event.target); });
  document.addEventListener('mouseup', () => { dragging = false; }, { once: false });
  document.querySelector('#scPen').addEventListener('click', event => {
    const button = event.target.closest('[data-pen]');
    if (!button) return;
    pen = button.dataset.pen;
    document.querySelectorAll('#scPen [data-pen]').forEach(item =>
      item.classList.toggle('active', item === button));
  });
  document.querySelector('#scPen [data-pen="day"]').classList.add('active');
  redraw();

  document.querySelector('#scSave').onclick = async () => {
    try {
      await api(`/api/staff/users/${id}/shifts`, {
        method: 'PUT', body: JSON.stringify({ month, days })
      });
      toast('График сохранён');
    } catch (error) { toast(error.message); }
  };
  const shiftMonth = delta => {
    const next = new Date(Date.UTC(year, mon - 1 + delta, 1));
    context.state.staffCardMonth = monthIso(next);
    reopen();
  };
  document.querySelector('#scMPrev').onclick = () => shiftMonth(-1);
  document.querySelector('#scMNext').onclick = () => shiftMonth(1);
  document.querySelector('#scEdit').onclick = () => staffEditDialog(context, person, reopen);
  document.querySelector('#scClose').onclick = () => { closeModal(); after?.(); };
  const fire = document.querySelector('#scFire');
  if (fire) fire.onclick = () => fireReasonDialog(context, person.fullName,
    'Учётка будет отключена, телефоны смены сняты; история сохранится.',
    async reason => {
      const result = await api(`/api/staff/users/${id}/fire`, { method: 'POST', body: JSON.stringify({ reason }) });
      const cleared = ['учётка отключена', 'телефон смены снят',
        result.cleared?.ext ? 'добавочный освобождён' : '',
        result.cleared?.telegram ? 'Telegram отвязан' : '',
        result.cleared?.futureShifts ? `смен снято: ${result.cleared.futureShifts}` : '']
        .filter(Boolean).join(', ');
      toast(`Сотрудник уволен (${cleared})`);
      after?.();
    });
  const restore = document.querySelector('#scRestore');
  if (restore) restore.onclick = async () => {
    try {
      await api(`/api/staff/users/${id}/restore`, { method: 'POST' });
      toast('Доступ восстановлен');
      reopen();
    } catch (error) { toast(error.message); }
  };
}

// Данные сотрудника: приём нового (с учёткой) и правка существующего.
function staffEditDialog(context, person, after) {
  const { showModal, closeModal, state } = context;
  const roles = state.data.user?.roles || [];
  const isAdmin = roles.includes('admin');
  const roleOptions = Object.entries({
    sales: 'Отдел продаж', logist: 'Логист', dispatcher: 'Диспетчер', resource: 'Ресурс',
    accountant: 'Бухгалтерия', mechanic: 'Механик', manager: 'Руководитель',
    ...(isAdmin ? { admin: 'Администратор' } : {})
  }).map(([value, label]) =>
    `<label style="display:inline-flex;gap:4px;margin-right:10px"><input type="checkbox" name="roles" value="${value}"> ${label}</label>`).join('');
  showModal(`<form id="staffForm">
    <h2>${person ? 'Данные сотрудника' : 'Приём сотрудника'}</h2>
    <label class="field">ФИО <input name="fullName" required value="${escapeHtml(person?.fullName || '')}"></label>
    <label class="field">Должность <input name="jobRole" placeholder="как в штатном расписании" value="${escapeHtml(person?.jobRole || '')}"></label>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
      <label class="field">Личный мобильный <input name="phone" value="${escapeHtml(person?.phone || '')}"></label>
      <label class="field">Добавочный АТС <input name="extPhone" value="${escapeHtml(person?.extPhone || '')}"></label>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
      <label class="field">E-mail <input name="email" type="email" value="${escapeHtml(person?.email || '')}"></label>
      <label class="field">В компании с <input name="hiredAt" type="date" value="${(person?.hiredAt || '').slice(0, 10)}"></label>
    </div>
    ${person ? '' : `
    <label class="field">Логин в планер <input name="username" required autocomplete="off"></label>
    <label class="field">Пароль (мин. 10 символов) <input name="password" required minlength="10" autocomplete="new-password"></label>
    <div class="field"><span>Роли в планере</span><div style="margin-top:4px">${roleOptions}</div></div>`}
    <div class="form-error" id="staffFormError"></div>
    <div style="display:flex;gap:8px;margin-top:10px">
      <button class="button primary" type="submit">${person ? 'Сохранить' : 'Принять'}</button>
      <button class="button ghost" type="button" id="staffFormCancel">Отмена</button>
    </div>
  </form>`);
  document.querySelector('#staffFormCancel').onclick = () => { closeModal(); after?.(); };
  document.querySelector('#staffForm').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const body = Object.fromEntries(['fullName', 'jobRole', 'phone', 'extPhone', 'email', 'hiredAt']
      .map(key => [key, String(values.get(key) || '').trim()]));
    try {
      if (person) {
        await api(`/api/staff/users/${person.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      } else {
        body.username = String(values.get('username') || '').trim();
        body.password = String(values.get('password') || '');
        body.roles = [...form.querySelectorAll('[name="roles"]:checked')].map(input => input.value);
        await api('/api/staff/users', { method: 'POST', body: JSON.stringify(body) });
      }
      toast(person ? 'Сохранено' : 'Сотрудник принят');
      closeModal(); after?.();
    } catch (error) {
      document.querySelector('#staffFormError').textContent = error.message;
    }
  });
}
