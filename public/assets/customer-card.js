// CRM-карточка клиента (блок «Продажи»): сводка по работе с заказчиком,
// контакты с днями рождения, журнал касаний (звонок/встреча/письмо/
// поздравление/претензия), заказы и реквизиты с условиями. Ближайшие
// поводы (🎂 контакты, 🎉 праздники) — в карточке и напоминанием в чат.
import { api, escapeHtml, formatDateTime, money, toast } from './api.js';

const STATUS_LABEL = { active: ['активный', 'ok'], prospect: ['потенциальный', 'warn'],
  sleeping: ['спящий', ''], lost: ['потерян', 'bad'] };
const NOTE_KIND = { note: '📝 Заметка', call: '📞 Звонок', meeting: '🤝 Встреча',
  email: '✉ Письмо', congrats: '🎉 Поздравление', claim: '⚠ Претензия' };
const ORDER_STAGE = { plan: 'назначена', run: 'в пути', unloaded: 'выгружена', done: 'завершена', paid: 'оплачена' };

const fmtDay = value => value
  ? new Date(String(value).includes('T') ? value : `${value}T12:00:00Z`)
    .toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—';
const fmtMmdd = mmdd => {
  const [month, day] = String(mmdd).slice(-5).split('-');
  return new Date(Date.UTC(2024, Number(month) - 1, Number(day)))
    .toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' });
};
const when = days => days === 0 ? 'сегодня' : days === 1 ? 'завтра' : `через ${days} дн.`;
const tsOf = value => String(value).includes('T') ? value : `${String(value).replace(' ', 'T')}Z`;

export async function customerCardDialog(name, context) {
  let card;
  try { card = await api(`/api/customers/card?name=${encodeURIComponent(name)}`); } catch (error) {
    toast(error.message, 'error'); return;
  }
  const canWrite = typeof context.can === 'function' && context.can('orders:write');
  let tab = context.customerCardTab || 'overview';
  const reload = async (nextTab = tab) => { context.customerCardTab = nextTab; await customerCardDialog(name, context); };

  const { profile, stats, contacts, notes, orders, dates, managers } = card;
  const [statusLabel, statusCls] = STATUS_LABEL[profile.status] || [profile.status, ''];
  const nextContactDue = profile.next_contact_at && profile.next_contact_at.slice(0, 10) <= new Date().toISOString().slice(0, 10);

  const overview = () => `
    <div class="cc-grid">
      <div class="cc-tile"><b>${stats.tripsDone}</b><span>рейсов выполнено</span><small>${stats.active ? `сейчас в работе ${stats.active}` : 'в работе нет'}</small></div>
      <div class="cc-tile"><b>${stats.count30}</b><span>рейсов за 30 дней</span><small>${money(stats.sum30)}</small></div>
      <div class="cc-tile"><b>${money(stats.sum90)}</b><span>выручка за 90 дней</span><small>${stats.count90} рейсов</small></div>
      <div class="cc-tile"><b>${money(stats.avgCheck)}</b><span>средний чек</span><small>всего ${money(stats.sumAll)}</small></div>
      <div class="cc-tile ${stats.daysSinceLast != null && stats.daysSinceLast > 30 ? 'warn' : ''}"><b>${stats.daysSinceLast != null ? `${stats.daysSinceLast} дн` : '—'}</b><span>с последнего рейса</span><small>${stats.lastTripAt ? fmtDay(stats.lastTripAt) : 'рейсов не было'}</small></div>
      <div class="cc-tile ${stats.claimsCount ? 'warn' : ''}"><b>${stats.claimsCount}</b><span>претензий по простою</span><small>${money(stats.claimsSum)}</small></div>
    </div>
    <div class="cc-cols">
      <div>
        <h4>Направления</h4>
        ${stats.topLanes.map(item => `<div class="cc-row">${escapeHtml(item.lane)} <b>${item.count}</b></div>`).join('') || '<p class="muted">Рейсов пока нет.</p>'}
        <h4 style="margin-top:10px">Условия</h4>
        <div class="cc-row">Ответственный: <b>${escapeHtml(profile.manager_name || '—')}</b></div>
        <div class="cc-row">Договор: <b>${escapeHtml(profile.contract_no || '—')}</b>${profile.contract_until ? ` до ${fmtDay(profile.contract_until)}` : ''}</div>
        <div class="cc-row">Отсрочка: <b>${profile.payment_days != null ? `${profile.payment_days} дн` : '—'}</b> · ИНН ${escapeHtml(profile.inn || '—')}</div>
        ${profile.conditions ? `<div class="cc-row muted">${escapeHtml(profile.conditions)}</div>` : ''}
      </div>
      <div>
        <h4>Ближайшие поводы</h4>
        ${dates.slice(0, 6).map(item => item.kind === 'birthday'
          ? `<div class="cc-row">🎂 ${escapeHtml(item.contact)}${item.position ? ` <small class="muted">${escapeHtml(item.position)}</small>` : ''} — ${fmtMmdd(item.date)} <b>${when(item.daysLeft)}</b></div>`
          : `<div class="cc-row">🎉 ${escapeHtml(item.name)} — ${fmtMmdd(item.date)} <b>${when(item.daysLeft)}</b></div>`).join('')
          || '<p class="muted">В ближайший месяц поводов нет.</p>'}
        <h4 style="margin-top:10px">Следующий контакт</h4>
        <div class="cc-row ${nextContactDue ? 'danger' : ''}">${profile.next_contact_at
          ? `${fmtDay(profile.next_contact_at)}${nextContactDue ? ' — пора связаться' : ''}` : 'не назначен'}</div>
        ${notes.slice(0, 3).map(note => `<div class="cc-row muted"><small>${NOTE_KIND[note.kind] || note.kind} · ${formatDateTime(tsOf(note.created_at))} · ${escapeHtml(note.author_name)}</small><br>${escapeHtml(note.text)}</div>`).join('')}
      </div>
    </div>`;

  const contactsTab = () => `
    ${contacts.map(contact => `<div class="cc-row cc-contact">
      <span style="flex:1;min-width:0"><b>${escapeHtml(contact.full_name)}</b>${contact.position ? ` · ${escapeHtml(contact.position)}` : ''}
        <small class="muted" style="display:block">${contact.phone ? `📞 <a href="tel:${escapeHtml(contact.phone)}">${escapeHtml(contact.phone)}</a> · ` : ''}${contact.email ? `✉ <a href="mailto:${escapeHtml(contact.email)}">${escapeHtml(contact.email)}</a> · ` : ''}${contact.birthday ? `🎂 ${fmtMmdd(contact.birthday)}${contact.daysToBirthday != null && contact.daysToBirthday <= 14 ? ` <b>${when(contact.daysToBirthday)}</b>` : ''}` : 'ДР не указан'}</small>
        ${contact.note ? `<small class="muted" style="display:block">${escapeHtml(contact.note)}</small>` : ''}</span>
      ${canWrite ? `<button class="button ghost small" data-cc-del-contact="${contact.id}" title="Удалить контакт">✕</button>` : ''}
    </div>`).join('') || '<p class="muted">Контактов пока нет — добавьте ЛПР, логиста клиента, бухгалтера.</p>'}
    ${canWrite ? `<form id="ccContactForm" class="cc-form">
      <div class="form-grid">
        <label class="field">ФИО *<input name="fullName" required maxlength="120"></label>
        <label class="field">Должность<input name="position" maxlength="120" placeholder="директор по логистике"></label>
        <label class="field">Телефон<input name="phone" maxlength="40" placeholder="+7 …"></label>
        <label class="field">Email<input name="email" type="email" maxlength="120"></label>
        <label class="field">День рождения<input name="birthday" placeholder="ГГГГ-ММ-ДД или ММ-ДД" maxlength="10"></label>
        <label class="field">Заметка<input name="note" maxlength="500" placeholder="чем занимается, предпочтения"></label>
      </div>
      <button class="button small">+ Добавить контакт</button>
    </form>` : ''}`;

  const journalTab = () => `
    ${canWrite ? `<form id="ccNoteForm" class="cc-form">
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        <select name="kind">${Object.entries(NOTE_KIND).map(([key, label]) => `<option value="${key}">${label}</option>`).join('')}</select>
        <input name="text" required maxlength="1000" placeholder="что обсудили, договорённости, итог" style="flex:1;min-width:220px">
        <button class="button small">Записать</button>
      </div>
      <div style="display:flex;gap:6px;align-items:center;margin-top:6px">
        <small class="muted">Следующий контакт</small>
        <input type="date" id="ccNextContact" value="${profile.next_contact_at ? profile.next_contact_at.slice(0, 10) : ''}">
        <button type="button" class="button ghost small" id="ccNextSave">Сохранить дату</button>
      </div>
    </form>` : ''}
    ${notes.map(note => `<div class="cc-row">
      <span style="flex:1;min-width:0"><small class="muted">${NOTE_KIND[note.kind] || note.kind} · ${formatDateTime(tsOf(note.created_at))} · ${escapeHtml(note.author_name)}</small><br>${escapeHtml(note.text)}</span>
      ${canWrite ? `<button class="button ghost small" data-cc-del-note="${note.id}" title="Удалить запись">✕</button>` : ''}
    </div>`).join('') || '<p class="muted">Журнал пуст — фиксируйте звонки, встречи и договорённости.</p>'}`;

  const ordersTab = () => orders.map(order => `<div class="cc-row">
      <span style="flex:1;min-width:0"><b>№ ${escapeHtml(order.order_no || '—')}</b> · ${escapeHtml(order.from_point || '')} → ${escapeHtml(order.to_point || '')}
        <small class="muted" style="display:block">окно ${formatDateTime(order.window_from)} → ${formatDateTime(order.window_to)}${order.vehicle_plate ? ` · ${escapeHtml(order.vehicle_plate)}` : ''}</small></span>
      <span style="text-align:right"><b>${money(order.rate_vat)}</b><br><small class="muted">${order.status === 'cancelled' ? 'отклонена' : (ORDER_STAGE[order.trip_status] || (Number(order.stage) === 0 ? 'ждёт подтверждения' : 'подтверждена'))}</small></span>
    </div>`).join('') || '<p class="muted">Заказов пока нет.</p>';

  const profileTab = () => canWrite ? `<form id="ccProfileForm" class="cc-form">
      <div class="form-grid">
        <label class="field">ИНН<input name="inn" value="${escapeHtml(profile.inn || '')}" maxlength="20"></label>
        <label class="field">Сегмент<select name="segment">${['', 'A', 'B', 'C'].map(value => `<option value="${value}" ${profile.segment === value ? 'selected' : ''}>${value || '—'}</option>`).join('')}</select></label>
        <label class="field">Статус<select name="status">${Object.entries(STATUS_LABEL).map(([key, [label]]) => `<option value="${key}" ${profile.status === key ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
        <label class="field">Ответственный<select name="managerId"><option value="">—</option>${managers.map(user => `<option value="${user.id}" ${profile.manager_id === user.id ? 'selected' : ''}>${escapeHtml(user.full_name)}</option>`).join('')}</select></label>
        <label class="field">Договор №<input name="contractNo" value="${escapeHtml(profile.contract_no || '')}" maxlength="60"></label>
        <label class="field">Договор до<input name="contractUntil" type="date" value="${profile.contract_until ? profile.contract_until.slice(0, 10) : ''}"></label>
        <label class="field">Отсрочка, дней<input name="paymentDays" type="number" min="0" value="${profile.payment_days ?? ''}"></label>
        <label class="field">Теги<input name="tags" value="${escapeHtml(profile.tags || '')}" placeholder="мясо, реф, сеть"></label>
      </div>
      <label class="field">Условия и особенности<textarea name="conditions" rows="3" maxlength="1000">${escapeHtml(profile.conditions || '')}</textarea></label>
      <button class="button small">Сохранить реквизиты</button>
    </form>` : `<div class="cc-row">ИНН ${escapeHtml(profile.inn || '—')} · сегмент ${escapeHtml(profile.segment || '—')} · договор ${escapeHtml(profile.contract_no || '—')}</div>`;

  const tabs = [['overview', 'Обзор'], ['contacts', `Контакты (${contacts.length})`], ['journal', `Журнал (${notes.length})`],
    ['orders', `Заказы (${orders.length})`], ['profile', 'Реквизиты']];
  context.showModal(`<h2>📇 ${escapeHtml(name)}
      <span class="badge ${statusCls}">${statusLabel}</span>${profile.segment ? ` <span class="badge">сегмент ${escapeHtml(profile.segment)}</span>` : ''}</h2>
    <div class="cc-tabs">${tabs.map(([key, label]) => `<button type="button" class="cc-tab ${tab === key ? 'on' : ''}" data-cc-tab="${key}">${label}</button>`).join('')}</div>
    <div class="cc-body">${({ overview, contacts: contactsTab, journal: journalTab, orders: ordersTab, profile: profileTab })[tab]()}</div>
    <div class="modal-actions"><button type="button" class="button ghost" data-close>Закрыть</button></div>`, 'wide');

  document.querySelectorAll('[data-cc-tab]').forEach(button =>
    button.addEventListener('click', () => reload(button.dataset.ccTab)));
  const post = async (url, method, body) => {
    try { await api(url, { method, body: body ? JSON.stringify(body) : undefined }); await reload(); }
    catch (error) { toast(error.message, 'error'); }
  };
  document.getElementById('ccContactForm')?.addEventListener('submit', event => {
    event.preventDefault();
    post('/api/customers/contacts', 'POST', { customerName: name, ...Object.fromEntries(new FormData(event.currentTarget)) });
  });
  document.getElementById('ccNoteForm')?.addEventListener('submit', event => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    post('/api/customers/notes', 'POST', { customerName: name, kind: values.kind, text: values.text });
  });
  document.getElementById('ccNextSave')?.addEventListener('click', () =>
    post('/api/customers/profile', 'PUT', { ...profileBody(profile), name, nextContactAt: document.getElementById('ccNextContact').value || null }));
  document.getElementById('ccProfileForm')?.addEventListener('submit', event => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    post('/api/customers/profile', 'PUT', { ...profileBody(profile), name, ...values,
      contractUntil: values.contractUntil || null, paymentDays: values.paymentDays === '' ? null : values.paymentDays });
  });
  document.querySelectorAll('[data-cc-del-contact]').forEach(button =>
    button.addEventListener('click', () => {
      if (confirm('Удалить контакт?')) post(`/api/customers/contacts/${button.dataset.ccDelContact}`, 'DELETE');
    }));
  document.querySelectorAll('[data-cc-del-note]').forEach(button =>
    button.addEventListener('click', () => post(`/api/customers/notes/${button.dataset.ccDelNote}`, 'DELETE')));
}

// Текущие поля профиля — чтобы частичное сохранение (дата контакта) не стёрло остальное.
const profileBody = profile => ({
  inn: profile.inn, segment: profile.segment, status: profile.status, managerId: profile.manager_id,
  contractNo: profile.contract_no, contractUntil: profile.contract_until, paymentDays: profile.payment_days,
  conditions: profile.conditions, nextContactAt: profile.next_contact_at, tags: profile.tags
});
