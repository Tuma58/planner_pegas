// Карточка по звонку водителя: всё, чем можно ответить, — на одном экране.
// Водитель звонит с погрузки или выгрузки и спрашивает про следующее задание,
// доверенность, адрес, телефон клиента, мойку, пересменку. Раньше сотрудник
// искал ответ по нескольким блокам, теперь карточка собирает их сама.
//
// До подключения телефонии карточка открывается поиском (номер ТС, фамилия
// водителя, телефон); после — тем же кодом по событию от АТС.
import { api, escapeHtml, formatDateTime, money, toast } from './api.js';

const HOUR = 3_600_000;

// Темы вопросов приходят с сервера вместе со списком; здесь — запасной
// список на случай, если карточка открылась раньше загрузки.
let TOPICS = [];

const fmt = iso => (iso ? formatDateTime(iso) : '—');
const clean = value => String(value || '').trim();

// Плашка ответа: заголовок, содержимое и, если данных нет, — честная
// подсказка, у кого спросить. Пустая плашка хуже отсутствия плашки.
const tile = (title, body, hint) => `<div class="callt ${body ? '' : 'empty'}">
  <div class="callt-h">${title}</div>
  <div class="callt-b">${body || `<span class="muted">${hint || 'данных нет'}</span>`}</div>
</div>`;

// Как на сервере (phonePretty): 10 цифр → «+7 (987) 510-59-21». Иначе во
// всплывашке Xsi показывались «голые» 9674483480 без кода страны.
const phonePrettyLocal = value => {
  let digits = String(value || '').replace(/\D+/g, '');
  if (!digits) return '';
  if (digits.length === 11 && (digits[0] === '8' || digits[0] === '7')) {
    digits = digits.slice(1);
  } else {
    digits = digits.slice(-10);
  }
  return digits.length === 10
    ? `+7 (${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6, 8)}-${digits.slice(8)}`
    : String(value || '').trim();
};

const phoneLink = phone => {
  const pretty = phonePrettyLocal(phone) || clean(phone);
  return pretty
    ? `<a href="tel:${escapeHtml(String(pretty).replace(/[^\d+]/g, ''))}">${escapeHtml(pretty)}</a>`
    : '';
};

// Этап рейса словами — тот же язык, что в контроле на линии.
function tripStageText(card) {
  const trip = card.active;
  if (!trip) return '';
  if (trip.status === 'plan') return '🕓 подготовка выхода';
  const stops = card.stops || [];
  const current = stops.find(stop => !stop.actual_departure);
  if (!current) return '📥 выгрузка завершена';
  const isFirst = current === stops[0];
  const isLast = current === stops[stops.length - 1];
  if (!current.actual_arrival) return isFirst ? '🛣 в пути на погрузку' : isLast ? '🛣 в пути на выгрузку' : '🛣 в пути';
  return isFirst ? '📦 на погрузке' : isLast ? '📥 на выгрузке' : '⏸ на промежуточной точке';
}

// Строка сервисного статуса водителя: отпуск/межвахта и СЛЕДУЮЩИЙ ВЫХОД
// (решение руководителя 07.10: отпускник звонит «когда выходить» — ответ
// должен быть в карточке одним взглядом).
const dayLabel = iso => iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}` : '';

// Прошлые обращения с резолюциями: что спрашивал и что ответили —
// контекст следующего звонка (решение руководителя 08.10).
function recentQuestionsBody(items) {
  return (items || []).length
    ? items.map(item => `<div class="call-note">
        <b>${escapeHtml(topicLabel(item.topic))}</b>
        <small class="muted">· ${fmt(String(item.closed_at).replace(' ', 'T') +
          (String(item.closed_at).includes('Z') ? '' : 'Z'))}
          ${item.closed_by_name ? ` · ${escapeHtml(item.closed_by_name)}` : ''}</small><br>
        ${item.resolution ? `✓ ${escapeHtml(item.resolution)}` : ''}
        ${item.note ? `<small class="muted" style="display:block">вопрос: ${escapeHtml(item.note)}</small>` : ''}
      </div>`).join('')
    : '';
}
function serviceLine(ds) {
  if (!ds) return '';
  const label = ds.state === 'vacation' ? `🌴 Отпуск до ${dayLabel(ds.absentTo)}`
    : ds.state === 'sick' ? `🤒 Больничный до ${dayLabel(ds.absentTo)}`
    : ds.state === 'rest' ? '🌙 Межвахта' : '';
  if (!label) return '';
  return `${label}${ds.nextOut ? ` · <b>следующий выход — ${dayLabel(ds.nextOut)}</b>` : ''}`
    + `${ds.shift ? ` · вахта ${ds.shift}` : ''}`
    + `${ds.vehiclePlate ? ` · сцепка <span class="mono">${escapeHtml(ds.vehiclePlate)}</span>` : ''}`;
}

export async function callCardDialog(context, { vehicleId = '', phone = '', callId = '' } = {}) {
  const query = new URLSearchParams();
  if (vehicleId) query.set('vehicleId', vehicleId);
  if (phone) query.set('phone', phone);
  let card;
  try {
    card = await api(`/api/call-card?${query}`);
  } catch (error) { toast(error.message, 'error'); return; }

  const vehicle = card.vehicle;
  if (!vehicle) {
    // Водитель без сцепки (отпуск, межвахта, резерв): сервисный ответ.
    if (card.driverStatus) {
      const ds = card.driverStatus;
      context.showModal(`<h2>📞 Звонит водитель</h2>
        <p><b>${escapeHtml(ds.fullName)}</b>${ds.phone ? ` · ${phoneLink(ds.phone)}` : ''}</p>
        <div class="call-open-q" style="margin:8px 0">${serviceLine(ds)
          || 'в строю, сцепка не закреплена — вопрос ресурснику'}</div>
        ${recentQuestionsBody(card.recentQuestions)
          ? `<div style="margin:8px 0"><b>📜 Прошлые обращения</b>
             ${recentQuestionsBody(card.recentQuestions)}</div>` : ''}
        <p class="muted">Полная картина — в карточке сотрудника
          (вкладка «Сотрудники» или «Ресурс → Водители»).</p>
        <div class="modal-actions">
          <button type="button" class="button ghost small" id="noVehNote">📝 Итог звонка</button>
          <button type="button" class="button ghost small" id="noVehQuestion">📞 Вопрос</button>
          <button type="button" class="button ghost" data-close>Закрыть</button>
        </div>`);
      document.getElementById('noVehQuestion').onclick = () => questionDialog(context, {
        driverName: ds.fullName, phone: ds.phone || phone, callId });
      document.getElementById('noVehNote').onclick = () => callNoteDialog(context, {
        driverName: ds.fullName, phone: ds.phone || phone, callId });
      return;
    }
    // Сотрудник: карточка не нужна — достаточно сказать, кто это.
    if (card.caller?.kind === 'employee') {
      context.showModal(`<h2>📞 Внутренний звонок</h2>
        <p><b>${escapeHtml(card.caller.name)}</b>
          ${card.caller.role ? ` · ${escapeHtml(card.caller.role)}` : ''}</p>
        <div class="modal-actions"><button type="button" class="button ghost" data-close>Закрыть</button></div>`);
      return;
    }
    // Неизвестный номер: звонок должен оставить след — пополнить
    // справочник или родить вопрос (решение руководителя 07.10).
    const customers = (context.state?.data?.customers || []).map(item => item.name).filter(Boolean);
    const drivers = (context.state?.data?.drivers || []).filter(item => item.status !== 'fired');
    context.showModal(`<h2>📞 Звонок</h2>
      <p class="muted">Номер ${escapeHtml(phonePrettyLocal(phone) || phone || '—')} в системе не найден: ни водитель,
        ни сотрудник, ни контакт клиента. Спросите, кто это, и привяжите номер —
        следующий звонок карточка узнает сама.</p>
      <form id="unkContactForm" style="border-top:1px solid var(--line,#d6e0e4);padding-top:8px">
        <b>➕ Это контакт клиента</b>
        <div class="form-grid">
          <label class="field">Клиент<input name="customerName" list="unkCustomers" required
            placeholder="начните вводить"><datalist id="unkCustomers">${customers.slice(0, 400)
      .map(name => `<option value="${escapeHtml(name)}">`).join('')}</datalist></label>
          <label class="field">ФИО контакта<input name="fullName" required></label>
        </div>
        <label class="field">Должность<input name="position" placeholder="логист, кладовщик…"></label>
        <button class="button small">Сохранить контакт</button>
      </form>
      <form id="unkDriverForm" style="border-top:1px solid var(--line,#d6e0e4);margin-top:10px;padding-top:8px">
        <b>👤 Это водитель</b> <small class="muted">(новый/второй номер — заменит номер в справочнике)</small>
        <label class="field">Водитель<input name="driverName" list="unkDrivers" required
          placeholder="фамилия"><datalist id="unkDrivers">${drivers.slice(0, 400)
      .map(item => `<option value="${escapeHtml(item.full_name)}">`).join('')}</datalist></label>
        <button class="button small">Привязать номер</button>
      </form>
      <div class="form-error" id="unkError"></div>
      <div class="modal-actions">
        <button type="button" class="button ghost small" id="unkQuestion">📞 Оформить вопрос</button>
        <button type="button" class="button ghost" data-close>Закрыть</button>
      </div>`);
    const unkError = document.getElementById('unkError');
    document.getElementById('unkContactForm').addEventListener('submit', async event => {
      event.preventDefault();
      const values = new FormData(event.currentTarget);
      try {
        await api('/api/customers/contacts', { method: 'POST', body: JSON.stringify({
          customerName: values.get('customerName'), fullName: values.get('fullName'),
          position: values.get('position'), phone }) });
        toast('Контакт сохранён — следующий звонок узнается');
        context.closeModal();
      } catch (error) { unkError.textContent = error.message; }
    });
    document.getElementById('unkDriverForm').addEventListener('submit', async event => {
      event.preventDefault();
      const name = String(new FormData(event.currentTarget).get('driverName') || '').trim().toLowerCase();
      const driver = drivers.find(item => item.full_name.toLowerCase() === name);
      if (!driver) { unkError.textContent = 'Выберите водителя из списка'; return; }
      try {
        await api(`/api/drivers/${driver.id}`, { method: 'PATCH', body: JSON.stringify({ phone }) });
        toast(`Номер привязан к водителю: ${driver.full_name}`);
        context.closeModal();
      } catch (error) { unkError.textContent = error.message; }
    });
    document.getElementById('unkQuestion').onclick = () => questionDialog(context, { phone, callId });
    return;
  }

  const trip = card.active;
  const order = card.order;
  const driverPhone = card.driver?.phone || '';
  const stage = tripStageText(card);
  // «Где машина сейчас»: этап рейса, перегон или оформленный простой.
  const whereBody = card.transfer
    ? `🚚 перегон порожним → <b>${escapeHtml(card.transfer.to_name || '')}</b>
       · ${escapeHtml(card.transfer.purpose || '')}
       <small class="muted" style="display:block">выезд ${fmt(card.transfer.starts_at)}
         · расчётное прибытие ${fmt(card.transfer.ends_at)}</small>`
    : trip
      ? `${stage} · <b>${escapeHtml(trip.from_point || trip.from_name || '')}</b> →
         <b>${escapeHtml(trip.to_point || trip.to_name || '')}</b>
         <small class="muted" style="display:block">выход ${fmt(trip.starts_at)}
           · расчётная выгрузка ${fmt(trip.ends_at)}</small>`
      : `стоит в «${escapeHtml(card.placeText || vehicle.zone_name || '—')}»${card.dispositionNow
        ? ` · ${escapeHtml(card.dispositionNow.kind)}` : ' · задания нет'}`;

  const nextBody = card.next
    ? `<b>${escapeHtml(card.next.from_point || card.next.from_name || '')}</b> →
       <b>${escapeHtml(card.next.to_point || card.next.to_name || '')}</b>
       <small class="muted" style="display:block">выход ${fmt(card.next.starts_at)}
         · ${escapeHtml(card.next.customer_name || '')}</small>`
    : '';

  const addressBody = order
    ? `<b>Погрузка:</b> ${escapeHtml(order.from_point || '')}
       ${order.from_address_text ? `<small class="muted" style="display:block">${escapeHtml(order.from_address_text)}</small>` : ''}
       <b>Выгрузка:</b> ${escapeHtml(order.to_point || '')}
       ${order.to_address_text ? `<small class="muted" style="display:block">${escapeHtml(order.to_address_text)}</small>` : ''}
       <small class="muted" style="display:block">окно клиента: ${fmt(order.window_from)} — ${fmt(order.window_to)}</small>`
    : '';

  const docsBody = order
    ? `Заявка № ${escapeHtml(String(order.order_no || '—'))} · ${escapeHtml(order.customer_name || '')}
       <small class="muted" style="display:block">ставка ${money(order.rate_vat)}
         · ${escapeHtml(order.body_type || '')}${order.temperature_mode ? ` · ${escapeHtml(order.temperature_mode)}` : ''}</small>
       ${order.comment ? `<small class="muted" style="display:block">💬 продажи: ${escapeHtml(order.comment)}</small>` : ''}`
    : '';

  const customerBody = (card.customerContacts || []).length
    ? card.customerContacts.map(contact => `<div>${escapeHtml(contact.full_name)}
        ${contact.position ? `<small class="muted">· ${escapeHtml(contact.position)}</small>` : ''}
        — ${phoneLink(contact.phone)}</div>`).join('')
    : '';

  const contactsBody = (card.contacts || []).length
    ? card.contacts.slice(0, 8).map(person => `<div>${escapeHtml(person.full_name)}
        <small class="muted">· ${escapeHtml(person.job_role || person.role || '')}</small>
        — ${phoneLink(person.phone)}</div>`).join('')
    : '';

  const statusLine = serviceLine(card.driverStatus);
  const shiftBody = [statusLine,
    card.nextShift
      ? `Пересменка ${fmt(card.nextShift.starts_at)} — ${fmt(card.nextShift.ends_at)}
       ${card.nextShift.note ? `<small class="muted" style="display:block">${escapeHtml(card.nextShift.note)}</small>` : ''}`
      : (!statusLine && card.driver?.shift_on && card.driver?.shift_off
        ? `Вахта ${card.driver.shift_on}/${card.driver.shift_off}`
        : '')].filter(Boolean).join('<br>');

  const servicesBody = (card.services || []).length
    ? card.services.map(point => `<div>${escapeHtml(point.name)}
        <small class="muted">· ${escapeHtml(point.address || point.region || '')}${point.km != null
  ? ` · ~${point.km} км` : ''}</small>
        ${point.phone ? ` — ${phoneLink(point.phone)}` : ''}</div>`).join('')
    : '';

  const openQuestions = card.openQuestions || [];

  // Комментарии смены по рейсу — те же, что видит диспетчер в карточке
  // контроля. Комментарий, оставленный отсюда, возвращается туда же:
  // хранилище одно (общие отметки смены), кто бы ни говорил с водителем.
  const notes = card.notes || [];
  const notesBody = notes.length
    ? notes.slice(0, 4).map(note => `<div class="call-note">
        <b>${escapeHtml(note.done_by || '')}</b>
        <small class="muted">· ${fmt(String(note.done_at).replace(' ', 'T') +
          (String(note.done_at).includes('Z') ? '' : 'Z'))}</small><br>
        ${escapeHtml(note.note)}</div>`).join('')
    : '';

  context.showModal(`<h2>📞 <span class="mono">${escapeHtml(vehicle.plate)}</span>
      ${vehicle.trailer_plate ? `<span class="mono muted"> / ${escapeHtml(vehicle.trailer_plate)}</span>` : ''}</h2>
    <p class="muted">${escapeHtml(card.driver?.full_name || vehicle.driver_name || 'без водителя')}
      ${driverPhone ? ` · ${phoneLink(driverPhone)}` : ''}
      · ${escapeHtml(vehicle.type_name || '')}
      ${card.caller?.kind === 'driver' ? ' · <b>звонит водитель</b>' : ''}</p>
    ${openQuestions.length ? `<div class="call-open-q">⏱ По этой машине уже есть незакрытые вопросы:
      ${openQuestions.map(item => escapeHtml(topicLabel(item.topic))).join(', ')}</div>` : ''}
    <div class="call-tiles">
      ${tile('📍 Где машина сейчас', whereBody)}
      ${tile('⏭ Следующее задание', nextBody, 'следующий рейс не назначен — вопрос логисту')}
      ${tile('📌 Адреса и окно по заявке', addressBody, 'рейс без заявки — сверьте с диспетчером')}
      ${tile('📄 Данные заявки для документов', docsBody, 'заявки нет — данные только из 1С')}
      ${tile('☎ Контакты клиента', customerBody, 'контакты клиента не заведены — вопрос продажам')}
      ${tile('🔧 Наши контакты', contactsBody, 'телефоны сотрудников не заполнены (Настройки → Пользователи)')}
      ${tile('🔁 Пересменка', shiftBody, 'пересменка не запланирована — вопрос ресурснику')}
      ${tile('🚿 Мойка, сервис, стоянка', servicesBody, 'справочник сервисов пуст (Настройки → Сервисы)')}
      ${tile(`💬 Комментарий по рейсу${trip ? `
        <button class="button ghost small" id="callNoteBtn" style="float:right;min-height:20px;padding:0 7px"
          title="Комментарий увидит вся смена — он же появится в карточке контроля">✎</button>` : ''}`,
    notesBody, trip ? 'комментариев по рейсу пока нет' : 'рейса нет — комментировать нечего')}
      ${tile('📜 Прошлые обращения', recentQuestionsBody(card.recentQuestions),
    'обращений ещё не было — первый разговор')}
    </div>
    <div class="modal-actions">
      <button type="button" class="button ghost" data-close>Закрыть</button>
      <button type="button" class="button ghost" id="callNoteResult"
        title="Необязательно: одна строка о разговоре — попадёт в «Прошлые обращения»">📝 Итог звонка</button>
      <button type="button" class="button" id="callQuestion">📞 Поступил вопрос</button>
    </div>`);
  document.getElementById('callNoteResult').onclick = () => callNoteDialog(context, {
    vehicleId: vehicle.id, driverName: card.driver?.full_name || vehicle.driver_name || '',
    phone: driverPhone || phone, callId });

  // Комментарий пишется в общие отметки смены (ключ заметки по рейсу) —
  // ровно туда, откуда его читает карточка контроля у диспетчера.
  document.getElementById('callNoteBtn')?.addEventListener('click', () => {
    const existing = notes.find(note => String(note.item_key).startsWith('prepnote|'));
    context.showModal(`<form id="callNoteForm">
      <h2>💬 Комментарий по рейсу</h2>
      <p class="muted">${escapeHtml(vehicle.plate)} · ${escapeHtml(trip?.customer_name || '')}</p>
      <label class="field">Текст (видит вся смена, появится в карточке контроля; пусто — удалить)
        <textarea name="note" maxlength="300" rows="3">${escapeHtml(existing?.note || '')}</textarea></label>
      <div class="modal-actions">
        <button type="button" class="button ghost" data-close>Отмена</button>
        <button class="button">Сохранить</button>
      </div></form>`);
    document.getElementById('callNoteForm').onsubmit = async event => {
      event.preventDefault();
      const note = String(new FormData(event.currentTarget).get('note') || '').trim();
      const day = new Date().toISOString().slice(0, 10);
      try {
        await api('/api/task-marks', { method: 'POST', body: JSON.stringify({
          kind: 'dispatcher', day, key: `prepnote|${trip.id}`,
          ...(note ? { note } : { remove: true })
        }) });
        toast(note ? 'Комментарий сохранён — виден смене в карточке контроля' : 'Комментарий удалён');
        context.closeModal();
        await callCardDialog(context, { vehicleId: vehicle.id });
      } catch (error) { toast(error.message, 'error'); }
    };
  });

  document.getElementById('callQuestion').onclick = () => questionDialog(context, {
    vehicleId: vehicle.id, tripId: trip?.id || '',
    driverName: card.driver?.full_name || vehicle.driver_name || '',
    phone: driverPhone || phone, callId
  });
}

// «📝 Итог звонка» (08.10): необязательная строка — рождается сразу
// закрытой записью и попадает в «📜 Прошлые обращения» этого водителя.
export function callNoteDialog(context, payload) {
  context.showModal(`<form id="callNoteForm">
    <h2>📝 Итог звонка</h2>
    <p class="muted">${escapeHtml(payload.driverName || '')}
      ${payload.phone ? ` · ${escapeHtml(payload.phone)}` : ''} — одна строка о разговоре;
      увидит любой, кому он позвонит в следующий раз.</p>
    <label class="field">Что обсудили / что ответили
      <input name="resolution" maxlength="500" required
        placeholder="например: подтвердил выход 21.10, напомнил про путевой лист"></label>
    <div class="modal-actions">
      <button type="button" class="button ghost" data-close>Отмена</button>
      <button class="button">Сохранить</button>
    </div></form>`);
  document.getElementById('callNoteForm').onsubmit = async event => {
    event.preventDefault();
    const resolution = String(new FormData(event.currentTarget).get('resolution') || '').trim();
    try {
      await api('/api/driver-questions', { method: 'POST', body: JSON.stringify({
        topic: 'call_note', vehicleId: payload.vehicleId || null,
        driverName: payload.driverName || '', phone: payload.phone || '',
        callId: payload.callId || null, resolution
      }) });
      context.closeModal();
      toast('Итог сохранён — виден в «Прошлых обращениях»');
    } catch (error) { toast(error.message, 'error'); }
  };
}

export function topicLabel(key) {
  return TOPICS.find(item => item.key === key)?.label || key;
}

export function setTopics(list) { TOPICS = list || []; }

// Фиксация вопроса: тема обязательна — по ней считается, какой шаг процесса
// пропущен и почему водитель вообще звонит.
export function questionDialog(context, payload) {
  const topics = TOPICS.length ? TOPICS : [{ key: 'other', label: 'Другое' }];
  context.showModal(`<form id="questionForm">
    <h2>📞 Поступил вопрос от водителя</h2>
    <p class="muted">${escapeHtml(payload.driverName || '')}
      ${payload.phone ? ` · ${escapeHtml(payload.phone)}` : ''}</p>
    <label class="field">Тема
      <select name="topic" required>
        <option value="">— выберите —</option>
        ${topics.map(topic => `<option value="${topic.key}">${escapeHtml(topic.label)}</option>`).join('')}
      </select></label>
    <label class="field">Суть вопроса<input name="note" maxlength="500"
      placeholder="кратко, своими словами"></label>
    <p class="muted">Норматив ответа — 10 минут. Пока вопрос открыт, он виден смене;
      после десяти минут карточка краснеет и уходит сигнал руководителю.</p>
    <div class="modal-actions">
      <button type="button" class="button ghost" data-close>Отмена</button>
      <button class="button">Зафиксировать</button>
    </div></form>`);
  document.getElementById('questionForm').onsubmit = async event => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    if (!values.topic) { toast('Выберите тему', 'error'); return; }
    try {
      await api('/api/driver-questions', { method: 'POST', body: JSON.stringify({
        ...payload, topic: values.topic, note: values.note
      }) });
      context.closeModal();
      toast('Вопрос зафиксирован — норматив 10 минут пошёл');
      await context.onReload();
    } catch (error) { toast(error.message, 'error'); }
  };
}

// Закрытие вопроса: без описания решения не закрывается — иначе статистика
// покажет «решено», а процесс останется сломанным.
export function closeQuestionDialog(context, question) {
  context.showModal(`<form id="closeQuestionForm">
    <h2>✓ Вопрос отработан</h2>
    <p class="muted">${escapeHtml(topicLabel(question.topic))}
      ${question.vehicle_plate ? ` · ${escapeHtml(question.vehicle_plate)}` : ''}
      ${question.note ? ` · «${escapeHtml(question.note)}»` : ''}</p>
    <label class="field">Что сделали<input name="resolution" maxlength="500" required
      placeholder="например: отправили данные грузоотправителю, водитель на погрузке"></label>
    <div class="modal-actions">
      <button type="button" class="button ghost" data-close>Отмена</button>
      <button class="button">Закрыть вопрос</button>
    </div></form>`);
  document.getElementById('closeQuestionForm').onsubmit = async event => {
    event.preventDefault();
    const resolution = new FormData(event.currentTarget).get('resolution');
    try {
      await api(`/api/driver-questions/${question.id}/close`, {
        method: 'POST', body: JSON.stringify({ resolution })
      });
      context.closeModal();
      toast('Вопрос закрыт');
      await context.onReload();
    } catch (error) { toast(error.message, 'error'); }
  };
}

// Полоса вопросов водителей для рабочего стола роли. Диспетчер видит все,
// остальные — вопросы своей зоны ответственности (тема знает, чей это шаг
// процесса) плюс всё просроченное: за 10 минут вопрос должен быть решён,
// и висеть он не должен ни у кого.
export const QUESTION_SLA_MS = 10 * 60_000;

export async function loadOpenQuestions() {
  try {
    const payload = await api('/api/driver-questions?open=1');
    setTopics(payload.topics);
    return payload.items.filter(item => !item.closed_at);
  } catch { return []; }
}

const questionOpenedMs = question => Date.parse(String(question.opened_at).replace(' ', 'T') +
  (String(question.opened_at).includes('Z') ? '' : 'Z'));

export function questionsForOwner(questions, owner) {
  if (!owner) return questions;
  return questions.filter(question => {
    const topic = TOPICS.find(item => item.key === question.topic);
    return topic?.owner === owner || Date.now() - questionOpenedMs(question) > QUESTION_SLA_MS;
  });
}

// compact — свёрнутая плашка со счётчиком: вопросы водителей адресованы
// прежде всего диспетчерской, а у продаж, логиста и ресурса они не должны
// занимать экран. Разворачивается кликом и запоминает состояние.
export function questionsStripHtml(questions, { title = '📞 Вопросы водителей',
  canAct = true, compact = false, open = false } = {}) {
  if (!questions.length) return '';
  const late = questions.filter(item => Date.now() - questionOpenedMs(item) > QUESTION_SLA_MS).length;
  const body = `<div class="list">${questions.map(question => {
    const waitMs = Date.now() - questionOpenedMs(question);
    const late = waitMs > QUESTION_SLA_MS;
    return `<div class="card question-card ${late ? 'late' : ''}" style="padding:8px 10px;margin-bottom:6px">
      <div class="list-item ordrow" style="border:0;padding:0 0 4px">
        <span style="flex:1;min-width:0">
          <strong>${escapeHtml(topicLabel(question.topic))}</strong>
          ${question.vehicle_plate ? `<small class="muted"> · <span class="mono">${escapeHtml(question.vehicle_plate)}</span></small>` : ''}
          <small class="muted" style="display:block">${escapeHtml(question.driver_name || question.vehicle_driver || '')}
            ${question.phone ? ` · ${escapeHtml(question.phone)}` : ''}
            ${question.note ? ` · «${escapeHtml(question.note)}»` : ''}</small>
          <small class="muted" style="display:block">принял ${escapeHtml(question.opened_by_name || '')}</small>
        </span>
        <span class="badge ${late ? 'bad' : 'warn'}">⏱ ${Math.max(0, Math.floor(waitMs / 60_000))} мин${late ? ' · просрочен' : ''}</span>
      </div>
      ${canAct ? `<div style="display:flex;gap:5px;flex-wrap:wrap">
        <button class="button small" data-question-close="${question.id}">✓ Отработано</button>
        ${question.vehicle_id ? `<button class="button ghost small" data-question-card="${question.vehicle_id}">📞 Карточка</button>` : ''}
      </div>` : ''}
    </div>`;
  }).join('')}</div>`;
  if (!compact) {
    return `<div class="questions-strip">
      <div class="scolh">${title} <span>${questions.length}</span>
        <small class="muted" style="font-weight:400"> · норматив ответа 10 минут</small></div>
      ${body}</div>`;
  }
  return `<details class="questions-strip compact" data-questions-toggle ${open ? 'open' : ''}>
    <summary>${title} <span class="scount ${late ? 'late' : ''}">${questions.length}</span>
      ${late ? `<span class="q-late">⏱ просрочено ${late}</span>` : ''}
      <small class="muted">— отвечает диспетчерская, норматив 10 минут</small></summary>
    ${body}</details>`;
}

export function wireQuestionsStrip(container, context, questions) {
  container.querySelectorAll('[data-question-close]').forEach(button =>
    button.addEventListener('click', () => {
      const question = questions.find(item => item.id === button.dataset.questionClose);
      if (question) closeQuestionDialog(context, question);
    }));
  container.querySelectorAll('[data-question-card]').forEach(button =>
    button.addEventListener('click', () => callCardDialog(context, { vehicleId: button.dataset.questionCard })));
}

// Поиск карточки по звонку: номер ТС, фамилия водителя или телефон.
export function callSearchDialog(context, data) {
  const vehicles = (data.vehicles || []).filter(item => item.status === 'work');
  context.showModal(`<h2>📞 Звонок водителя</h2>
    <p class="muted">Введите номер ТС, фамилию водителя или телефон — откроется карточка
      с ответами на типовые вопросы.</p>
    <input id="callSearchInput" placeholder="🔍 например: р265 или Акимов или 5921" autocomplete="off"
      style="width:100%;margin-bottom:8px">
    <div class="list" id="callSearchList" style="max-height:340px;overflow:auto"></div>
    <div class="modal-actions"><button type="button" class="button ghost" data-close>Закрыть</button></div>`);
  const input = document.getElementById('callSearchInput');
  const list = document.getElementById('callSearchList');
  const drivers = data.drivers || [];
  const render = () => {
    const needle = input.value.trim().toLowerCase().replace(/\s+/g, '');
    if (needle.length < 2) {
      list.innerHTML = '<p class="muted">Начните вводить — минимум два символа.</p>';
      return;
    }
    const digits = needle.replace(/\D+/g, '');
    const rows = vehicles.filter(vehicle => {
      const driver = drivers.find(item => item.vehicle_id === vehicle.id);
      const phone = String(driver?.phone || '').replace(/\D+/g, '');
      return String(vehicle.plate).toLowerCase().replace(/\s+/g, '').includes(needle)
        || String(vehicle.driver_name || '').toLowerCase().includes(needle)
        || (digits.length >= 3 && phone.includes(digits));
    }).slice(0, 30);
    list.innerHTML = rows.length ? rows.map(vehicle => {
      const driver = drivers.find(item => item.vehicle_id === vehicle.id);
      return `<button type="button" class="list-item" data-call-vehicle="${vehicle.id}">
        <span style="flex:1;min-width:0"><strong class="mono">${escapeHtml(vehicle.plate)}</strong>
          <small class="muted"> · ${escapeHtml(vehicle.driver_name || 'без водителя')}${driver?.phone
  ? ` · ${escapeHtml(driver.phone)}` : ''}</small></span>
      </button>`;
    }).join('') : '<p class="muted">Ничего не найдено.</p>';
    list.querySelectorAll('[data-call-vehicle]').forEach(button =>
      button.addEventListener('click', () => callCardDialog(context, { vehicleId: button.dataset.callVehicle })));
  };
  input.addEventListener('input', render);
  render();
  input.focus();
}

// Всплытие карточки по входящему звонку: пока телефония выключена, опрос не
// идёт вовсе — лишних запросов нет.
// Уголок-подсказка по ИСХОДЯЩЕМУ (08.10): сотрудник сам набрал номер и
// знает, кому звонит, — модалка не нужна, но карточка в один клик под
// рукой. Чекбокс «сразу карточку» — выбор рабочего места (localStorage).
function outgoingCallPop(context, call) {
  let instant = false;
  try { instant = localStorage.getItem('outCallCard') === '1'; } catch { /* ок */ }
  const open = () => callCardDialog(context, { vehicleId: call.vehicle_id || '',
    phone: call.from_digits || call.to_phone, callId: call.id });
  if (instant) { open(); return; }
  document.getElementById('outCallPop')?.remove();
  const pop = document.createElement('div');
  pop.id = 'outCallPop';
  pop.className = 'out-call-pop';
  pop.innerHTML = `<span>📞 Исходящий: <b>${escapeHtml(call.matched_name
    || phonePrettyLocal(call.to_phone) || 'номер не найден')}</b>
    ${call.vehicle_plate ? ` · <span class="mono">${escapeHtml(call.vehicle_plate)}</span>` : ''}</span>
    <button class="button small" data-pop-card>Карточка</button>
    <label class="muted" style="font-size:11px;display:inline-flex;gap:3px;align-items:center">
      <input type="checkbox" data-pop-instant> сразу карточку</label>
    <button class="button ghost small" data-pop-close>✕</button>`;
  document.body.appendChild(pop);
  const close = () => pop.remove();
  pop.querySelector('[data-pop-card]').onclick = () => { close(); open(); };
  pop.querySelector('[data-pop-close]').onclick = close;
  pop.querySelector('[data-pop-instant]').onchange = event => {
    try { localStorage.setItem('outCallCard', event.currentTarget.checked ? '1' : '0'); } catch { /* ок */ }
  };
  setTimeout(() => { if (pop.isConnected) pop.remove(); }, 12_000);
}

export function watchIncomingCalls(context) {
  const settings = context.state.data.settings || {};
  if (!settings.telephony?.enabled || settings.telephony?.popup === false) return null;
  const seen = new Set();
  const tick = async () => {
    try {
      const { items } = await api('/api/telephony/incoming');
      for (const call of items) {
        if (seen.has(call.id)) continue;
        seen.add(call.id);
        await api(`/api/telephony/calls/${call.id}/handled`, { method: 'POST' }).catch(() => {});
        // Исходящий самого сотрудника: тихий уголок с карточкой в клик.
        if (call.direction === 'out') {
          outgoingCallPop(context, call);
          continue;
        }
        // Внутренний звонок: карточка не нужна — тихий тост «кто звонит»
        // (решение руководителя 07.10), журнал запись сохраняет.
        if (call.matched_kind === 'employee') {
          toast(`📞 Звонит ${call.matched_name || 'сотрудник'}`);
          continue;
        }
        callCardDialog(context, { vehicleId: call.vehicle_id || '',
          phone: call.from_phone, callId: call.id });
        break;
      }
    } catch { /* сеть моргнула — попробуем на следующем тике */ }
  };
  return setInterval(tick, 5_000);
}

export const CALL_HOUR = HOUR;
