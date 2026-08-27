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

const phoneLink = phone => clean(phone)
  ? `<a href="tel:${escapeHtml(String(phone).replace(/[^\d+]/g, ''))}">${escapeHtml(phone)}</a>` : '';

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
    context.showModal(`<h2>📞 Звонок</h2>
      <p class="muted">Номер ${escapeHtml(phone || '—')} в системе не найден: ни водитель,
        ни сотрудник, ни контакт клиента.</p>
      <p>Спросите номер ТС или фамилию водителя и найдите карточку поиском.</p>
      <div class="modal-actions"><button type="button" class="button ghost" data-close>Закрыть</button></div>`);
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

  const shiftBody = card.nextShift
    ? `Пересменка ${fmt(card.nextShift.starts_at)} — ${fmt(card.nextShift.ends_at)}
       ${card.nextShift.note ? `<small class="muted" style="display:block">${escapeHtml(card.nextShift.note)}</small>` : ''}`
    : (card.driver?.shift_on && card.driver?.shift_off
      ? `Вахта ${card.driver.shift_on}/${card.driver.shift_off}`
      : '');

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
    </div>
    <div class="modal-actions">
      <button type="button" class="button ghost" data-close>Закрыть</button>
      <button type="button" class="button" id="callQuestion">📞 Поступил вопрос</button>
    </div>`);

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

export function questionsStripHtml(questions, { title = '📞 Вопросы водителей', canAct = true } = {}) {
  if (!questions.length) return '';
  return `<div class="questions-strip">
    <div class="scolh">${title} <span>${questions.length}</span>
      <small class="muted" style="font-weight:400"> · норматив ответа 10 минут</small></div>
    <div class="list">${questions.map(question => {
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
  }).join('')}</div></div>`;
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
        callCardDialog(context, { vehicleId: call.vehicle_id || '',
          phone: call.from_phone, callId: call.id });
        break;
      }
    } catch { /* сеть моргнула — попробуем на следующем тике */ }
  };
  return setInterval(tick, 5_000);
}

export const CALL_HOUR = HOUR;
