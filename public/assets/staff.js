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
  // Справочник должностей структуры СТ (блок 1 «Слияния») — для формы.
  state.staffPositions = payload.positions || [];
  state.staffRoleSets = payload.roleSets || [];
  state.staffAllViews = payload.allViews || [];
  state.staffCanManageAccess = Boolean(payload.canManageAccess);
  const query = (state.staffQuery || '').toLowerCase();
  const matches = person => !query ||
    `${person.fullName} ${person.jobRole} ${person.phone} ${person.extPhone || ''} ${person.username || ''} ${person.vehiclePlate || ''}`
      .toLowerCase().includes(query);
  const mismatch = person => person.active && !person.externalGuest && roleMismatch(person, payload);
  const users = payload.users.filter(matches).filter(person => !state.staffOnlyMismatch || mismatch(person));
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
      ${person.externalGuest ? `<small class="bi-tag" style="display:block" title="${escapeHtml(person.guestNote || '')}">гость до ${fmtDate(person.guestUntil)}</small>`
    : person.guest ? '<small class="muted" style="display:block">только просмотр</small>' : ''}
      ${accessTag(person)}</td>
    <td>${escapeHtml(person.jobRole || '—')}
      ${person.positionId ? '' : '<small class="bi-tag warn" title="Должность не из справочника структуры — выберите в «✎ Данные»">вне структуры</small>'}
      </td>
    <td>${roleCell(person, payload, state)}</td>
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

  // BI-вид (04.11): плитки состава → секции «Офис»/«Водители» с .bi-table.
  const activeUsers = payload.users.filter(person => person.active);
  // С ролью, но без входа — кандидаты на массовую выдачу (админа не трогаем).
  const noAccess = activeUsers.filter(person => person.roles?.length && !person.roles.includes('admin')
    && (!person.canLogin || (person.roleSets?.length && !standardLogin(person.username))));
  const firedAll = payload.users.length - activeUsers.length;
  const withTg = activeUsers.filter(person => person.telegram).length;
  const driversNoCar = payload.drivers.filter(person => !person.vehiclePlate).length;
  const tile = (label, value, unit, extra, note = '') => `<div class="metric ${extra}">
    <span class="l">${label}</span><span class="v">${value}<small>${unit}</small></span>
    ${note ? `<span class="d">${note}</span>` : ''}</div>`;
  const tableSection = (title, hint, head, rows, empty) => `<section class="section dept-staff">
      <div class="sec-h"><span class="st">${title}</span>${hint ? `<span class="hint">${hint}</span>` : ''}</div>
      <div class="sec-b flush"><div class="bi-scroll"><table class="bi-table"><thead><tr>${head}</tr></thead>
        <tbody>${rows || `<tr><td colspan=6 class="muted">${empty}</td></tr>`}</tbody></table></div></div>
    </section>`;
  const html = `<div class="bi-page svc-staff" id="staffBoard">
    <div class="bi-sub">
      <span class="staff-seg">
        <button data-staff-sec="office" class="${section === 'office' ? 'active' : ''}">Офис · ${activeUsers.length}</button>
        <button data-staff-sec="drivers" class="${section === 'drivers' ? 'active' : ''}">Водители · ${payload.drivers.length}</button>
      </span>
      <label class="muted" style="display:inline-flex;gap:4px;align-items:center;white-space:nowrap"
        title="Только те, у кого роль не совпадает с правами должности (или роли нет при должности со входом)">
        <input type="checkbox" id="staffMismatch" ${state.staffOnlyMismatch ? 'checked' : ''} style="width:auto">
        роль не по должности · ${payload.users.filter(mismatch).length}</label>
      <input id="staffSearch" class="block-search" placeholder="Поиск по всем: ФИО, должность, телефон, сцепка"
        value="${escapeHtml(state.staffQuery || '')}" style="flex:1;min-width:180px;max-width:360px">
      <div class="bi-actions">
      <button class="button small ghost" id="staffTimesheet"
        title="Общий план-график смен офиса на месяц: Д/Н/отпуск/болезнь, клик по клетке — цикл, печать">📅 Табель смен</button>
      <button class="button small ghost" id="staffAts"
        title="Абоненты АТС Билайн: кто из сотрудников на каком добавочном; несопоставленные номера — привязать или оставить незадействованными">☎ Сверка с АТС</button>
      ${noAccess.length ? `<button class="button small ghost" id="staffIssueAll"
        title="Логин и временный пароль всем с ролью, у кого ещё нет входа — листок для печати">🔐 Выдать доступ · ${noAccess.length}</button>` : ''}
      ${state.staffCanManageAccess ? '<button class="button small ghost" id="staffAddGuest" title="Внешний человек: только просмотр по выбранному набору, со сроком доступа">＋ Гость</button>' : ''}
      <button class="button small" id="staffAddUser">+ Сотрудник</button>
      <button class="button small ghost" id="staffAddDriver" title="Водители заводятся в справочнике «Водители» — там же сцепка и вахта">+ Водитель</button>
      </div>
    </div>
    <div class="bi-kpis">
      ${tile('Офис работает', activeUsers.filter(person => !person.externalGuest).length, 'чел', 'dept-staff',
    `гостей ${activeUsers.filter(person => person.externalGuest).length}`)}
      ${tile('Водители', payload.drivers.length, 'чел', 'dept-drv', `без сцепки ${driversNoCar}`)}
      ${tile('Telegram привязан', withTg, `из ${activeUsers.length}`, 'dept-staff', 'офис, получают уведомления')}
      ${tile('Уволенные', firedAll, 'чел', firedAll ? 'warn' : 'dept-staff', 'серыми в списке офиса')}
      ${tile('Без роли', activeUsers.filter(person => !person.roles?.length).length, 'чел', 'dept-staff', 'в штате, но без входа в планер')}
      ${tile('Вход', activeUsers.filter(person => person.canLogin && !person.mustChangePassword).length, `из ${activeUsers.filter(person => person.roles?.length).length}`,
    noAccess.length ? 'warn' : 'dept-staff', `ждут выдачи ${noAccess.length} · не сменили временный ${activeUsers.filter(person => person.canLogin && person.mustChangePassword).length}`)}
    </div>
    ${query && !users.length && !drivers.length ? '<div class="bi-empty">Никого не найдено.</div>' : ''}
    ${showOffice ? tableSection(query ? `Офис · найдено ${users.length}` : 'Офис',
    fired.length ? 'уволенные остаются в списке серыми — карточка и история доступны, восстановление из карточки' : '',
    '<th>Сотрудник</th><th>Должность</th><th title="Выберите — сохраняется сразу; жёлтым — роль не совпадает с должностью">Роль в планере</th><th>Телефоны</th><th>TG</th><th>Статус</th>',
    users.map(userRow).join(''), 'Никого не найдено') : ''}
    ${showDrivers ? tableSection(query ? `Водители · найдено ${drivers.length}` : 'Водители', '',
    '<th>Водитель</th><th>Должность</th><th>Телефон</th><th>Сцепка</th><th>Статус</th>',
    drivers.map(driverRow).join(''), 'Никого не найдено') : ''}
  </div>`;
  if (!renderInto(container, html)) return;

  container.querySelectorAll('[data-staff-sec]').forEach(button =>
    button.onclick = () => {
      state.staffSection = button.dataset.staffSec;
      renderStaff(container, context);
    });
  container.querySelector('#staffMismatch').onchange = event => {
    state.staffOnlyMismatch = event.currentTarget.checked;
    renderStaff(container, context);
  };
  // Роль прямо в списке: выбор — сразу сохранение (PATCH роли).
  container.querySelectorAll('[data-role-pick]').forEach(select => select.onchange = async () => {
    const id = select.dataset.rolePick;
    const value = select.value;
    try {
      await api(`/api/staff/users/${id}`, { method: 'PATCH', body: JSON.stringify({ roleSets: value ? [value] : [] }) });
      toast(value ? 'Роль назначена' : 'Роль снята — входа в планер нет');
    } catch (error) { toast(error.message); }
    renderStaff(container, context);
  });
  const search = container.querySelector('#staffSearch');
  search.addEventListener('input', () => {
    state.staffQuery = search.value;
    renderStaff(container, context);
  });
  container.querySelector('#staffAddUser').onclick = () => staffEditDialog(context, null,
    () => renderStaff(container, context));
  container.querySelector('#staffTimesheet').onclick = () => staffTimesheetDialog(context);
  container.querySelector('#staffAts').onclick = () => staffAtsDialog(context,
    () => renderStaff(container, context));
  container.querySelector('#staffAddDriver').onclick = () => context.openDrivers?.();
  const issueAll = container.querySelector('#staffIssueAll');
  if (issueAll) issueAll.onclick = async () => {
    if (!confirm(`Выдать логин и временный пароль ${noAccess.length} сотрудникам: с ролью и без входа, а также с прежним логином не по образцу?\n\nПароли покажутся один раз — сразу распечатайте листок.`)) return;
    try {
      const result = await api('/api/staff/access/bulk', { method: 'POST', body: JSON.stringify({}) });
      credentialsSheet(context, result.items, () => renderStaff(container, context));
    } catch (error) { toast(error.message); }
  };
  const addGuest = container.querySelector('#staffAddGuest');
  if (addGuest) addGuest.onclick = () => guestDialog(context, null, () => renderStaff(container, context));
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
      <th title="Галочка: входящие на этот номер фиксируются в системе (пропущенные → вопросы). Снята — звонки на номер не шумят. Дежурные номера фиксируются всегда">📵 Фикс.</th>
      <th>Добавочный</th><th>Моб. АТС</th><th>Сотрудник</th><th></th>
    </tr></thead><tbody>
      ${items.map(item => `<tr>
        <td><input type="checkbox" data-ats-track="${escapeHtml(String(item.ext))}" ${item.tracked !== false ? 'checked' : ''}
          title="Фиксировать входящие на этот номер (пропущенные → вопросы)"></td>
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
  document.querySelectorAll('[data-ats-track]').forEach(box =>
    box.onchange = async () => {
      try {
        await api('/api/staff/ats/track', { method: 'POST', body: JSON.stringify({
          ext: box.dataset.atsTrack, tracked: box.checked }) });
        toast(box.checked ? 'Входящие на номер фиксируются' : 'Номер исключён из фиксации');
      } catch (error) { box.checked = !box.checked; toast(error.message, 'error'); }
    });
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
      в компании с ${fmtDate(person.hiredAt)} · ${person.canLogin
    ? `учётка ${escapeHtml(person.username)} · последний вход ${fmtDateTime(person.lastLoginAt)}${person.mustChangePassword ? ' · <b>временный пароль ещё не сменён</b>' : ''}`
    : person.roles?.length ? 'роль есть, входа ещё нет — нажмите «🔐 Выдать доступ»'
      : 'без входа в планер — сначала назначьте роль в «✎ Данные»'}</p>
    ${(() => {
    // Чек-лист приёма (этап 4, 09.10): виден первые 30 дней, пока не
    // закрыты все пункты — ничего не забыть при вводе человека в строй.
    const hiredMs = Date.parse(String(person.hiredAt || '').slice(0, 10));
    const fresh = Number.isFinite(hiredMs) && Date.now() - hiredMs < 30 * 86_400_000;
    const items = [
      ['Учётка', Boolean(person.canLogin), 'роль — «✎ Данные», логин и пароль — «🔐 Выдать доступ»'],
      ['Личный телефон', Boolean(person.phone), '«✎ Данные» → личный мобильный'],
      ['Добавочный АТС', Boolean(person.extPhone), '«☎ Сверка с АТС» или «✎ Данные» — без него карточка звонка не найдёт адресата'],
      ['Telegram', Boolean(person.telegram), 'сотрудник привязывает бота сам — инструкция в «?» раздел «Общее»'],
      ['Инструкции', Boolean(person.guideAckAt), 'сотрудник читает «?» и жмёт «✍ Подтвердить ознакомление»'],
      ['График месяца', Object.keys(card.shifts || {}).length > 0, 'заполните смены пером ниже'],
      ['Первый вход', Boolean(person.lastLoginAt), 'выдайте логин и пароль — при входе укажет рабочий телефон']
    ];
    const open = items.filter(([, done]) => !done);
    if (!fresh || !open.length || !person.active) return '';
    return `<div style="background:var(--panel2);border-radius:10px;padding:10px 12px;margin-bottom:10px">
      <h3 style="margin:0 0 6px;font-size:12px;color:var(--muted)">🚀 ЧЕК-ЛИСТ ПРИЁМА · выполнено ${items.length - open.length}/${items.length}</h3>
      <div style="display:flex;flex-wrap:wrap;gap:6px">${items.map(([label, done, hint]) =>
    `<span class="badge ${done ? 'ok' : 'warn'}" title="${escapeHtml(hint)}">${done ? '✓' : '✗'} ${label}</span>`).join('')}</div>
      ${open.length ? `<div class="muted" style="font-size:11.5px;margin-top:5px">${open.map(([label, , hint]) => `<b>${label}</b>: ${escapeHtml(hint)}`).join(' · ')}</div>` : ''}
    </div>`;
  })()}
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px" class="staff-grid">
      <div class="sec" style="background:var(--panel2);border-radius:10px;padding:10px 12px">
        <h3 style="margin:0 0 6px;font-size:12px;color:var(--muted)">📞 СВЯЗЬ</h3>
        <div class="dash-row"><span>Добавочный АТС</span><b>${escapeHtml(person.extPhone || '—')}</b></div>
        <div class="dash-row"><span>Личный мобильный</span><b>${escapeHtml(person.phone || '—')}</b></div>
        <div class="dash-row"><span>Телефон смены</span><b>${escapeHtml(person.workPhone || '—')}</b></div>
        <div class="dash-row"><span>Telegram</span><b>${person.telegram ? '✓ привязан' : '—'}</b></div>
        <div class="dash-row"><span>E-mail</span><b>${escapeHtml(person.email || '—')}</b></div>
      </div>
      <div class="sec" style="background:var(--panel2);border-radius:10px;padding:10px 12px">
        <h3 style="margin:0 0 6px;font-size:12px;color:var(--muted)">🔐 ДОСТУП</h3>
        <div class="dash-row"><span>Роль (набор)</span><b>${escapeHtml((person.roleSets || []).map(id =>
    (context.state.staffRoleSets || []).find(set => set.id === id)?.title || id).join(' + ') || 'не назначена')}</b></div>
        <div class="dash-row"><span>Права (коды)</span><b>${escapeHtml(person.roleLabel)}</b></div>
        <div class="dash-row"><span>Инструкции</span><b>${person.guideAckAt ? `✍ ${fmtDate(person.guideAckAt)}` : '—'}</b></div>
        <div class="dash-row"><span>Учётка</span><b>${person.active ? 'активна' : 'отключена'}${person.externalGuest ? ` · гость до ${fmtDate(person.guestUntil)}` : person.guest ? ' · только просмотр' : ''}</b></div>
        <div class="dash-row"><span>Затраты</span><b>${person.expensesAccess ? '💸 есть доступ' : '—'}</b></div>
        <div class="dash-row"><span>Пароль</span><b>${!person.canLogin ? 'не выдан'
    : person.mustChangePassword ? 'временный — сменит при входе'
      : `свой${person.passwordChangedAt ? ` с ${fmtDate(person.passwordChangedAt)}` : ''}`}</b></div>
      </div>
    </div>
    <div style="background:var(--panel2);border-radius:10px;padding:10px 12px;margin-top:10px">
      <h3 style="margin:0 0 6px;font-size:12px;color:var(--muted)">📅 ГРАФИК —
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
      <h3 style="margin:0 0 6px;font-size:12px;color:var(--muted)">🕘 ИСТОРИЯ</h3>
      <div style="font-size:12.5px;max-height:160px;overflow:auto">${card.history.map(histRow).join('') || '<span class="muted">пусто</span>'}</div>
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:12px">
      ${person.externalGuest ? '<button class="button" id="scGuest">✎ Гостевой доступ</button>'
    : '<button class="button" id="scEdit">✎ Данные</button>'}
      ${person.active && person.roles?.length && (!person.roles.includes('admin') || isAdminUser(context))
    ? (person.canLogin && standardLogin(person.username)
      ? '<button class="button ghost" id="scAccess" title="Новый временный пароль; логин прежний; сотрудник сменит пароль при входе">↻ Сбросить пароль</button>'
      : `<button class="button ghost" id="scAccess" title="${person.canLogin ? `Прежний логин «${escapeHtml(person.username)}» заменится стандартным; новый временный пароль` : 'Логин и временный пароль — показываются один раз'}">🔐 Выдать доступ</button>`) : ''}
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
  const editButton = document.querySelector('#scEdit');
  if (editButton) editButton.onclick = () => staffEditDialog(context, person, reopen);
  const guestButton = document.querySelector('#scGuest');
  if (guestButton) guestButton.onclick = () => guestDialog(context, person, reopen);
  const accessButton = document.querySelector('#scAccess');
  if (accessButton) accessButton.onclick = async () => {
    if (person.canLogin && !confirm(standardLogin(person.username)
      ? `Сбросить пароль «${person.fullName}»? Прежний перестанет работать, открытые сессии закроются.`
      : `Выдать «${person.fullName}» стандартный логин вместо «${person.username}» и временный пароль? Прежний вход перестанет работать, открытые сессии закроются.`)) return;
    try {
      const result = await api(`/api/staff/users/${id}/access`, { method: 'POST', body: JSON.stringify({}) });
      credentialsSheet(context, result.items, reopen);
    } catch (error) { toast(error.message); }
  };
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

// Выбор должности из справочника структуры СТ, по отделам и группам.
// Старый текст должности (до справочника) виден отдельной строкой, пока
// человеку не назначат должность структуры.
const DEPT_TITLES = { staff: 'Штаб', log: 'Логистика', drv: 'Эксплуатация', toir: 'ТОиР' };
function positionSelect(positions, person) {
  const office = positions.filter(item => !item.driverPool);
  const groups = [];
  for (const item of office) {
    const key = `${DEPT_TITLES[item.dept] || item.dept} · ${item.group}`;
    let group = groups.find(entry => entry.key === key);
    if (!group) groups.push(group = { key, items: [] });
    group.items.push(item);
  }
  const legacy = person && !person.positionId && person.jobRole;
  return `<label class="field">Должность в структуре
    <select name="positionId">
      ${legacy ? `<option value="__keep" selected>прежняя: «${escapeHtml(person.jobRole)}» (вне структуры)</option>` : ''}
      <option value="" ${!legacy && !person?.positionId ? 'selected' : ''}>— не назначена</option>
      ${groups.map(group => `<optgroup label="${escapeHtml(group.key)}">${group.items.map(item =>
    `<option value="${item.id}" ${person?.positionId === item.id ? 'selected' : ''}>${escapeHtml(item.title)}</option>`).join('')}</optgroup>`).join('')}
    </select>
    <small class="muted">справочник — экран «Структура»; у должности есть свой набор прав — он отмечается сам</small></label>`;
}

// Роль-набор (поле управления, 07.11): одна роль = область + экраны +
// права + уровень денег. Чекбоксы — для совмещения должностей.
const MONEY_TITLE = { full: 'все деньги', rates: 'ставки', none: 'без денег' };
function roleSetPicker(sets, current, isAdmin) {
  return `<div class="field"><span>Роль в планере <small class="muted">— набор под должность: что видит и что может</small></span>
    <div class="st-roles">${sets.filter(set => isAdmin || set.id !== 'admin').map(set => `<label>
      <input type="checkbox" name="roleSets" value="${set.id}" ${current.includes(set.id) ? 'checked' : ''}>
      <span><b>${escapeHtml(set.title)}</b> <small class="muted">${set.views.length} экр. · ${MONEY_TITLE[set.money] || ''}</small></span></label>`).join('')}</div>
    <small class="muted">без роли — сотрудник в штате, но в планер не входит; вход — «🔐 Выдать доступ» в карточке</small></div>`;
}

// Данные сотрудника: приём нового (с учёткой) и правка существующего.
function staffEditDialog(context, person, after) {
  const { showModal, closeModal, state } = context;
  const roles = state.data.user?.roles || [];
  const isAdmin = roles.includes('admin');
  showModal(`<form id="staffForm">
    <h2>${person ? 'Данные сотрудника' : 'Приём сотрудника'}</h2>
    <label class="field">ФИО <input name="fullName" required value="${escapeHtml(person?.fullName || '')}"></label>
    ${positionSelect(state.staffPositions || [], person)}
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
      <label class="field">Личный мобильный <input name="phone" value="${escapeHtml(person?.phone || '')}"></label>
      <label class="field">Добавочный АТС <input name="extPhone" value="${escapeHtml(person?.extPhone || '')}"></label>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
      <label class="field">E-mail <input name="email" type="email" value="${escapeHtml(person?.email || '')}"></label>
      <label class="field">В компании с <input name="hiredAt" type="date" value="${(person?.hiredAt || '').slice(0, 10)}"></label>
    </div>
    ${person ? '' : `
    <details class="st-pp"><summary>🔐 Доступ в планер <small class="muted">— не обязательно: без роли сотрудник в штате, но не входит</small></summary>
    ${rolePickerForm(state, [], '', isAdmin)}
    <small class="muted">логин и временный пароль — кнопкой «🔐 Выдать доступ» в карточке после приёма</small></details>`}
    ${person ? rolePickerForm(state, person.roleSets || [], person.positionId, isAdmin) : ''}
    ${person && !person.roles?.includes('admin') ? `<label style="display:inline-flex;gap:6px;align-items:center;margin:4px 0">
      <input type="checkbox" name="readOnly" style="width:auto;height:auto;flex:none;margin:0" ${person.guest ? 'checked' : ''}>
      👁 только просмотр <small class="muted">(гостевой режим: видит экраны своей роли, ничего не меняет)</small></label><br>` : ''}
    ${person?.canSetExpenses && !person.roles?.includes('admin') ? `<label style="display:inline-flex;gap:6px;align-items:center;margin:4px 0">
      <input type="checkbox" name="expensesAccess" style="width:auto;height:auto;flex:none;margin:0" ${person.expensesAccess ? 'checked' : ''}>
      💸 доступ к «Затратам» <small class="muted">(экран учёта затрат: журнал, суммы, импорт — персонально)</small></label><br>` : ''}
    ${person ? `<label style="display:inline-flex;gap:6px;align-items:center;margin:4px 0">
      <input type="checkbox" name="dispatchExempt" style="width:auto;height:auto;flex:none;margin:0" ${person?.dispatchExempt ? 'checked' : ''}>
      не участвует в автораспределении диспетчерской
      <small class="muted">(руководитель службы: карточки доски ему не назначаются)</small></label>
    <label class="field">Эскалации доски
      <select name="escRole">
        <option value="" ${!person?.escRole ? 'selected' : ''}>— не принимает</option>
        <option value="senior" ${person?.escRole === 'senior' ? 'selected' : ''}>Старший смены (1-й уровень)</option>
        <option value="head" ${person?.escRole === 'head' ? 'selected' : ''}>Руководитель службы (2-й уровень)</option>
      </select>
      <small class="muted">кому доска поднимает сильно просроченные карточки; текст должности на это больше не влияет</small></label>` : ''}
    <div class="form-error" id="staffFormError"></div>
    <div style="display:flex;gap:8px;margin-top:10px">
      <button class="button primary" type="submit">${person ? 'Сохранить' : 'Принять'}</button>
      <button class="button ghost" type="button" id="staffFormCancel">Отмена</button>
    </div>
  </form>`);
  // Права по должности (10.11): выбор должности отмечает её набор;
  // руководитель может поправить галки вручную (совмещение).
  const positionField = document.querySelector('#staffForm [name="positionId"]');
  positionField?.addEventListener('change', () => {
    const position = (state.staffPositions || []).find(item => item.id === positionField.value);
    if (!position) return;
    const set = position.roleSet || '';
    const main = document.querySelector('#staffForm [name="roleMain"]');
    if (main) main.innerHTML = roleOptions(state.staffRoleSets || [], set, set, isAdmin);
    document.querySelectorAll('#staffForm [name="roleExtra"]').forEach(input => { input.checked = false; });
    const details = document.querySelector('#staffForm details');
    if (details) details.open = true;
    toast(set ? 'Роль отмечена по должности — проверьте перед сохранением'
      : 'У этой должности нет входа в планер — роль снята');
  });
  document.querySelector('#staffFormCancel').onclick = () => { closeModal(); after?.(); };
  document.querySelector('#staffForm').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const body = Object.fromEntries(['fullName', 'phone', 'extPhone', 'email', 'hiredAt']
      .map(key => [key, String(values.get(key) || '').trim()]));
    // Должность — из справочника структуры; «прежняя» — текст без изменений.
    const position = String(values.get('positionId') || '');
    if (position !== '__keep') body.positionId = position;
    if (person) body.dispatchExempt = form.querySelector('[name="dispatchExempt"]')?.checked || false;
    if (person) body.escRole = String(values.get('escRole') || '');
    if (person) body.roleSets = pickedSets(form);
    const expensesBox = form.querySelector('[name="expensesAccess"]');
    if (person && expensesBox && expensesBox.checked !== Boolean(person.expensesAccess)) body.expensesAccess = expensesBox.checked;
    const readOnly = form.querySelector('[name="readOnly"]');
    if (person && readOnly && readOnly.checked !== Boolean(person.guest)) body.readOnly = readOnly.checked;
    try {
      if (person) {
        await api(`/api/staff/users/${person.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      } else {
        body.roleSets = pickedSets(form);
        await api('/api/staff/users', { method: 'POST', body: JSON.stringify(body) });
      }
      toast(person ? 'Сохранено' : 'Сотрудник принят');
      closeModal(); after?.();
    } catch (error) {
      document.querySelector('#staffFormError').textContent = error.message;
    }
  });
}


// ── 📅 Табель смен офиса (заказ руководителя 11.10) ─────────────────
// Общий план-график на месяц: строки — сотрудники, колонки — дни.
// Клик по клетке — цикл «пусто → Д → Н → ОТ → Б → пусто» (точная
// установка дня, API exclusive); листается на любой месяц; печать —
// чистой страницей в альбомной ориентации.
const TS_CYCLE = [null, 'day', 'night', 'vacation', 'sick'];
const TS_LABEL = { day: 'Д', night: 'Н', vacation: 'ОТ', sick: 'Б' };
const TS_CLASS = { day: 'ts-d', night: 'ts-n', vacation: 'ts-o', sick: 'ts-b' };

export async function staffTimesheetDialog(context) {
  const { state, showModal } = context;
  state.tsMonth = state.tsMonth || new Date().toISOString().slice(0, 7);
  const render = async () => {
    const month = state.tsMonth;
    const daysInMonth = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();
    const from = `${month}-01`;
    const to = `${month}-${String(daysInMonth).padStart(2, '0')}`;
    let payload;
    try { payload = await api(`/api/staff-shifts?from=${from}&to=${to}`); }
    catch (error) { toast(error.message, 'error'); return; }
    // Офисные: водителей в табеле нет (их график — в «Ресурсе»).
    const staff = payload.staff.filter(person => person.role !== 'driver');
    const byUser = new Map();
    for (const item of payload.items) {
      if (!byUser.has(item.user_id)) byUser.set(item.user_id, {});
      byUser.get(item.user_id)[item.day] = item.kind;
    }
    const isWeekend = dayNo => [0, 6].includes(
      new Date(Date.parse(`${month}-${String(dayNo).padStart(2, '0')}T00:00:00Z`)).getUTCDay());
    const headDays = Array.from({ length: daysInMonth }, (_, i) =>
      `<th class="${isWeekend(i + 1) ? 'ts-we' : ''}">${i + 1}</th>`).join('');
    const rows = staff.map(person => {
      const days = byUser.get(person.id) || {};
      const counts = { day: 0, night: 0, vacation: 0, sick: 0 };
      const cells = Array.from({ length: daysInMonth }, (_, i) => {
        const iso = `${month}-${String(i + 1).padStart(2, '0')}`;
        const kind = days[iso] || null;
        if (kind && counts[kind] != null) counts[kind] += 1;
        return `<td class="ts-cell ${kind ? TS_CLASS[kind] : ''} ${isWeekend(i + 1) ? 'ts-we' : ''}"
          data-ts-cell="${person.id}|${iso}" data-ts-kind="${kind || ''}"
          title="${escapeHtml(person.full_name)} · ${iso} — клик: пусто → Д → Н → ОТ → Б">${kind ? TS_LABEL[kind] : ''}</td>`;
      }).join('');
      return `<tr><td class="ts-name">${escapeHtml(person.full_name)}
          <small class="muted">${escapeHtml(person.job_role || '')}</small></td>
        ${cells}
        <td class="ts-sum">${counts.day}/${counts.night}${counts.vacation ? ` · от ${counts.vacation}` : ''}${counts.sick ? ` · б ${counts.sick}` : ''}</td></tr>`;
    }).join('');
    const dayTotals = Array.from({ length: daysInMonth }, (_, i) => {
      const iso = `${month}-${String(i + 1).padStart(2, '0')}`;
      let n = 0;
      for (const person of staff) {
        const kind = (byUser.get(person.id) || {})[iso];
        if (kind === 'day' || kind === 'night') n += 1;
      }
      return `<td class="${isWeekend(i + 1) ? 'ts-we' : ''}">${n || ''}</td>`;
    }).join('');
    showModal(`<div class="ts-wrap" id="tsWrap">
      <div class="ts-bar">
        <h2 style="margin:0">📅 Табель смен офиса</h2>
        <span class="resctl-group">
          <button class="button small ghost" id="tsPrev">◀</button>
          <b style="padding:0 10px">${month}</b>
          <button class="button small ghost" id="tsNext">▶</button>
        </span>
        <span class="muted">Д — дневная · Н — ночная · ОТ — отпуск · Б — больничный · клик по клетке меняет план</span>
        <button class="button small" id="tsPrint">🖨 Печать</button>
        <button class="button small ghost" data-close>Закрыть</button>
      </div>
      <div class="ts-scroll"><table class="ts-table" id="tsTable">
        <thead><tr><th class="ts-name">Сотрудник</th>${headDays}<th class="ts-sum">Д/Н</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><td class="ts-name">В смене (Д+Н)</td>${dayTotals}<td></td></tr></tfoot>
      </table></div>
    </div>`, { wide: true });
    document.getElementById('tsPrev').onclick = () => { state.tsMonth = shiftMonth(month, -1); render(); };
    document.getElementById('tsNext').onclick = () => { state.tsMonth = shiftMonth(month, 1); render(); };
    document.getElementById('tsPrint').onclick = () => {
      const win = window.open('', '_blank');
      win.document.write(`<html><head><title>Табель смен · ${month}</title><style>
        body{font:11px/1.3 "Segoe UI",Arial,sans-serif;margin:10mm}
        h2{font-size:14px;margin:0 0 8px}
        table{border-collapse:collapse;width:100%}
        th,td{border:1px solid #999;padding:1px 3px;text-align:center;font-size:10px}
        td:first-child,th:first-child{text-align:left;white-space:nowrap}
        .ts-d{background:#cfe8d1}.ts-n{background:#cddff5}.ts-o{background:#ffe7ad}.ts-b{background:#e3e3e3}
        .ts-we{background:#f6dede}
        @page{size:landscape;margin:8mm}
      </style></head><body>
      <h2>Табель смен офиса · ${month}</h2>
      ${document.getElementById('tsTable').outerHTML}
      <p>Д — дневная · Н — ночная · ОТ — отпуск · Б — больничный. Сформировано ${new Date().toLocaleString('ru-RU')}.</p>
      </body></html>`);
      win.document.close();
      win.focus();
      win.print();
    };
    document.querySelectorAll('[data-ts-cell]').forEach(cell => cell.onclick = async () => {
      const [userId, iso] = cell.dataset.tsCell.split('|');
      const current = cell.dataset.tsKind || null;
      const next = TS_CYCLE[(TS_CYCLE.indexOf(current) + 1) % TS_CYCLE.length];
      try {
        await api('/api/staff-shifts', { method: 'POST',
          body: JSON.stringify({ exclusive: true, userId, day: iso, kind: next }) });
        cell.dataset.tsKind = next || '';
        cell.className = `ts-cell ${next ? TS_CLASS[next] : ''} ${cell.classList.contains('ts-we') ? 'ts-we' : ''}`;
        cell.textContent = next ? TS_LABEL[next] : '';
      } catch (error) { toast(error.message, 'error'); }
    });
  };
  const shiftMonth = (month, delta) => {
    const d = new Date(Date.parse(month + '-01T00:00:00Z'));
    d.setUTCMonth(d.getUTCMonth() + delta);
    return d.toISOString().slice(0, 7);
  };
  await render();
}

const isAdminUser = context => (context.state.data?.user?.roles || []).includes('admin');

// Статус доступа в строке списка.
function accessTag(person) {
  if (!person.active || !person.roles?.length) return '';
  if (!person.canLogin) return '<small class="bi-tag warn" style="display:block" title="Роль есть, логина и пароля нет — «🔐 Выдать доступ»">входа нет</small>';
  if (person.roleSets?.length && !standardLogin(person.username)) return `<small class="bi-tag warn" style="display:block" title="Прежний логин «${escapeHtml(person.username)}» — «🔐 Выдать доступ» даст стандартный логин и временный пароль, как всем">логин не по образцу</small>`;
  if (person.mustChangePassword) return '<small class="bi-tag" style="display:block" title="Выдан временный пароль — сотрудник ещё не входил и не сменил его">временный пароль</small>';
  return '';
}

// ── 🔐 Листок доступа: логин и временный пароль — ОДИН раз ──
// Пароли больше нигде не хранятся в открытом виде: закрыли окно —
// остаётся только «↻ Сбросить пароль».
export function credentialsSheet(context, items, after) {
  const { showModal, closeModal } = context;
  if (!items?.length) { toast('Выдавать некому — у всех с ролью вход уже есть'); after?.(); return; }
  const origin = location.origin;
  const rows = items.map(item => `<tr><td>${escapeHtml(item.fullName)}<small class="muted" style="display:block">${escapeHtml(item.position || '')}${item.renamedFrom ? ` · прежний логин «${escapeHtml(item.renamedFrom)}» больше не работает` : ''}</small></td>
    <td class="mono"><b>${escapeHtml(item.username)}</b></td><td class="mono"><b>${escapeHtml(item.password)}</b></td>
    <td><button type="button" class="button ghost small" data-cred-copy="${items.indexOf(item)}" title="Скопировать вход этого сотрудника">📋</button></td></tr>`).join('');
  showModal(`<div>
    <h2>🔐 Доступ выдан · ${items.length}</h2>
    <p class="muted" style="font-size:12.5px">Пароли показаны <b>один раз</b> — распечатайте или перепишите сейчас.
      При первом входе сотрудник придумает свой пароль; временный после этого не работает.
      Адрес входа: <b>${escapeHtml(origin)}</b></p>
    <div style="overflow:auto;max-height:52vh"><table class="bi-table"><thead><tr><th>Сотрудник</th><th>Логин</th><th>Временный пароль</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    <div class="modal-actions">
      <button type="button" class="button" id="credCopy" title="Все входы текстом — вставить в мессенджер или документ">📋 Скопировать все</button>
      <button type="button" class="button primary" id="credPrint">🖨 Печать листков</button>
      <button type="button" class="button ghost" id="credClose">Готово</button></div>
  </div>`);
  document.querySelector('#credPrint').onclick = () => printCredentials(items, origin);
  document.querySelector('#credCopy').onclick = async () => {
    await copyToClipboard(credentialsText(items, origin));
    toast(`Скопировано входов: ${items.length}`);
  };
  document.querySelectorAll('[data-cred-copy]').forEach(button => button.onclick = async () => {
    const item = items[Number(button.dataset.credCopy)];
    await copyToClipboard(credentialsText([item], origin));
    toast(`Вход «${item.fullName}» скопирован`);
  });
  document.querySelector('#credClose').onclick = () => {
    if (!confirm('Закрыть? Пароли больше не будут показаны.')) return;
    closeModal(); after?.();
  };
}

// Печать: по листку-отрывному на человека (ФИО, адрес, логин, пароль,
// что делать при первом входе).
function printCredentials(items, origin) {
  const win = window.open('', '_blank', 'width=800,height=900');
  if (!win) { toast('Браузер заблокировал окно печати — разрешите всплывающие окна'); return; }
  const card = item => `<div class="c"><h3>Вход в планер «Пегас-Авто»</h3>
    <p class="n">${escapeHtml(item.fullName)}${item.position ? ` · ${escapeHtml(item.position)}` : ''}</p>
    <table><tr><td>Адрес</td><td><b>${escapeHtml(origin)}</b></td></tr>
      <tr><td>Логин</td><td><b>${escapeHtml(item.username)}</b></td></tr>
      <tr><td>Временный пароль</td><td><b>${escapeHtml(item.password)}</b></td></tr></table>
    <p class="h">При первом входе система попросит придумать свой пароль: не короче 10 символов,
      буквы и цифры. Никому не сообщайте пароль; забыли — руководитель сбросит.
      ${item.guestUntil ? `Гостевой доступ (только просмотр) действует до ${new Date(item.guestUntil).toLocaleDateString('ru-RU')}.` : ''}</p></div>`;
  win.document.write(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Доступ в планер</title>
    <style>body{font:13px/1.4 system-ui,sans-serif;margin:16px;color:#111}
    .c{border:1px dashed #888;border-radius:8px;padding:10px 14px;margin:0 0 12px;break-inside:avoid}
    h3{margin:0 0 4px;font-size:14px}.n{margin:0 0 6px;font-weight:600}
    table{border-collapse:collapse}td{padding:2px 12px 2px 0}td b{font-family:ui-monospace,Menlo,monospace;font-size:15px}
    .h{margin:6px 0 0;color:#444;font-size:11.5px}</style></head>
    <body>${items.map(card).join('')}<script>window.onload=()=>window.print()<\/script></body></html>`);
  win.document.close();
}

// ── Гость: внешний человек, только просмотр по набору, со сроком ──
export function guestDialog(context, guest, after) {
  const { showModal, closeModal, state } = context;
  const sets = (state.staffRoleSets || []).filter(set => !set.codes?.includes('admin'));
  const inMonth = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
  showModal(`<form id="guestForm">
    <h2>${guest ? `Гостевой доступ · ${escapeHtml(guest.fullName)}` : '＋ Гость'}</h2>
    <p class="muted" style="font-size:12.5px">Гость видит экраны выбранного набора и <b>ничего не может менять</b>.
      В штат и структуру не входит. По окончании срока вход закрывается сам.</p>
    ${guest ? '' : `<label class="field">ФИО <input name="fullName" required></label>
    <label class="field">E-mail <small class="muted">(не обязательно)</small><input name="email" type="email"></label>`}
    <label class="field">Кто и зачем <input name="note" value="${escapeHtml(guest?.guestNote || '')}" placeholder="например: аудитор, собственник, проверка за ноябрь"></label>
    <label class="field">Что видит (набор) <select name="roleSet">${sets.map(set =>
    `<option value="${set.id}" ${guest?.roleSets?.includes(set.id) ? 'selected' : ''}>${escapeHtml(set.title)} · ${MONEY_TITLE[set.money] || ''}</option>`).join('')}</select></label>
    <label class="field">Доступ до (включительно) <input name="until" type="date" required value="${(guest?.guestUntil || inMonth).slice(0, 10)}"></label>
    <div class="form-error" id="guestError"></div>
    <div class="modal-actions">
      ${guest ? '<button type="button" class="button ghost danger" id="guestClose">⏹ Закрыть доступ сейчас</button>' : ''}
      <button type="button" class="button ghost" data-close>Отмена</button>
      <button class="button primary">${guest ? 'Сохранить' : 'Создать и выдать доступ'}</button></div>
  </form>`);
  const form = document.querySelector('#guestForm');
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form));
    try {
      if (guest) {
        await api(`/api/staff/guests/${guest.id}`, { method: 'PATCH', body: JSON.stringify(values) });
        toast('Гостевой доступ сохранён');
        closeModal(); after?.();
      } else {
        const result = await api('/api/staff/guests', { method: 'POST', body: JSON.stringify(values) });
        credentialsSheet(context, result.items, after);
      }
    } catch (error) { document.querySelector('#guestError').textContent = error.message; }
  });
  const stop = document.querySelector('#guestClose');
  if (stop) stop.onclick = async () => {
    if (!confirm(`Закрыть доступ «${guest.fullName}» сейчас?`)) return;
    const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
    try {
      await api(`/api/staff/guests/${guest.id}`, { method: 'PATCH', body: JSON.stringify({ until: yesterday }) });
      toast('Доступ гостя закрыт');
      closeModal(); after?.();
    } catch (error) { document.querySelector('#guestError').textContent = error.message; }
  };
}

// ── Роль в планере — по отделам, с подсказкой «по должности» (10.11) ──
const SCOPE_TITLE = { all: 'Направление', staff: 'Штаб', log: 'Логистика', drv: 'Эксплуатация', toir: 'ТОиР', '': 'Прочее' };
const SCOPE_ORDER = ['all', 'staff', 'log', 'drv', 'toir', ''];
function setsByScope(sets, isAdmin) {
  return SCOPE_ORDER.map(scope => [scope, sets.filter(set => (set.scope || '') === scope
    && (isAdmin || !set.codes?.includes('admin')))]).filter(([, list]) => list.length);
}
const positionSetOf = (person, payload) => (payload.positions || []).find(item => item.id === person.positionId)?.roleSet || '';
// Роль не совпадает с правами должности (или роли нет при должности со входом).
function roleMismatch(person, payload) {
  if (person.roles?.includes('admin') || !person.positionId) return false;
  const expected = positionSetOf(person, payload);
  const own = person.roleSets || [];
  return expected ? !own.includes(expected) : own.length > 0;
}
function roleOptions(sets, current, expected, isAdmin) {
  return `<option value="" ${!current ? 'selected' : ''}>— без входа${expected === '' ? ' (по должности)' : ''}</option>
    ${setsByScope(sets, isAdmin).map(([scope, list]) => `<optgroup label="${SCOPE_TITLE[scope]}">${list.map(set =>
    `<option value="${set.id}" ${set.id === current ? 'selected' : ''}>${escapeHtml(set.title)}${set.id === expected ? ' ✓ по должности' : ''}</option>`).join('')}</optgroup>`).join('')}`;
}
function roleCell(person, payload, state) {
  if (!person.active) return '<small class="muted">—</small>';
  if (person.roles?.includes('admin')) return '<small class="muted">администратор</small>';
  const own = person.roleSets || [];
  if (own.length > 1) {
    return `<small title="Совмещение — меняется в карточке «✎ Данные»">совмещение: ${escapeHtml((person.roleSetTitles || own).join(' + '))}</small>`;
  }
  const expected = person.positionId ? positionSetOf(person, payload) : null;
  const off = person.positionId && roleMismatch(person, payload);
  return `<select data-role-pick="${person.id}" class="staff-role-pick ${off ? 'warn' : ''}"
      title="${off ? 'Роль не совпадает с правами должности' : 'Роль в планере — сохраняется сразу'}">
    ${roleOptions(state.staffRoleSets || [], own[0] || '', expected, false)}</select>`;
}

// В карточке: основная роль одним выбором (по отделам, «✓ по должности»)
// + совмещение галками — только когда человек правда совмещает.
function rolePickerForm(state, current, positionId, isAdmin) {
  const sets = state.staffRoleSets || [];
  const expected = positionId ? (state.staffPositions || []).find(item => item.id === positionId)?.roleSet || '' : null;
  const [main = '', ...extra] = current;
  return `<label class="field">Роль в планере <small class="muted">— что видит и что может; «✓ по должности» — права её должности</small>
      <select name="roleMain">${roleOptions(sets, main, expected, isAdmin)}</select></label>
    <details class="st-pp" ${extra.length ? 'open' : ''}><summary>＋ Совмещение <small class="muted">— вторая роль, если человек совмещает должности</small></summary>
      <div class="st-roles">${sets.filter(set => isAdmin || !set.codes?.includes('admin')).map(set => `<label>
        <input type="checkbox" name="roleExtra" value="${set.id}" ${extra.includes(set.id) ? 'checked' : ''}>
        <span>${escapeHtml(set.title)} <small class="muted">${SCOPE_TITLE[set.scope || '']}</small></span></label>`).join('')}</div></details>`;
}
function pickedSets(form) {
  const main = String(form.querySelector('[name="roleMain"]')?.value || '');
  const extra = [...form.querySelectorAll('[name="roleExtra"]:checked')].map(input => input.value);
  return [...new Set([main, ...extra].filter(Boolean))];
}

// Текст входа для мессенджера / документа: адрес один раз, дальше по
// строке на человека, в конце — правило первого входа.
function credentialsText(items, origin) {
  return [`Вход в планер «Пегас-Авто»: ${origin}`, '',
    ...items.map(item => `${item.fullName}${item.position ? ` (${item.position})` : ''} — логин: ${item.username} · временный пароль: ${item.password}`
      + (item.guestUntil ? ` · гостевой доступ до ${new Date(item.guestUntil).toLocaleDateString('ru-RU')}` : '')),
    '', 'При первом входе планер попросит придумать свой пароль (не короче 10 символов, буквы и цифры).'].join('\n');
}

async function copyToClipboard(text) {
  try { await navigator.clipboard.writeText(text); return; } catch { /* нет доступа к буферу — запасной путь */ }
  const area = document.createElement('textarea');
  area.value = text;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  try { document.execCommand('copy'); } finally { area.remove(); }
}

// Логин «по образцу» — как на сервере (credentials.isStandardLogin).
const standardLogin = login => /^[a-z0-9]+(\.[a-z0-9]+)?$/.test(String(login || ''));
