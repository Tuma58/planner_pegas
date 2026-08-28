// Доска отдела продаж — перенос renderSalesBoard из прототипа ТК 21:
// слева «Потребность от логистики» (освобождающиеся сцепки с предложением обратного груза),
// справа форма бронирования с оценкой осуществимости и портфель заявок со стадиями.
// Назначение ТС — через POST /api/orders/:id/assign (право trips:write).
import { api, attachSearch, escapeHtml, formatDateTime, formValues, money, parseMoney, routeLabel, toLocalInput, toast, transitHours, tripBusyUntilMs, wireSelectSearch, dayPickerHtml, wireDayPicker, captureScrolls, restoreScrolls, renderInto } from './api.js';
import { demurrageChipHtml, wireDemurrageChip } from './demurrage.js';
import { deliveryPlanDialog } from './delivery-plan.js';
import { salesRadarDialog, directionMarket, freeVehiclesByZone } from './sales-radar.js';
import { customerCardDialog } from './customer-card.js';
import { loadOpenQuestions, questionsForOwner, questionsStripHtml, wireQuestionsStrip } from './call-card.js';
import { STAGES, inSalesPortfolio, myTasks, orderStage, pipelineStep, waitingLabel } from './pipeline.js';
import { DISP_KINDS } from './resource.js';

export { STAGES, orderStage };

const fmtDay = value => new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' })
  .format(new Date(value));
// Планирование ведётся с точностью до минут: окна погрузки и моменты освобождения
// показываются вместе с временем суток.
const fmtDateTime = formatDateTime;

// Значение для <input type="datetime-local"> — в часовом поясе предприятия.
const inputValue = toLocalInput;

// Дефолты планирования: погрузка с 08:00, приём груза до 18:00,
// подача под погрузку — через 2 часа после освобождения сцепки.
const WORK_START_HOUR = 8;
const WORK_END_HOUR = 18;
const DISPATCH_LAG_MS = 2 * 3_600_000;

function atHour(date, hour) {
  const result = new Date(date);
  result.setUTCHours(hour, 0, 0, 0);
  return result;
}

// Справочник адресов: точное совпадение по наименованию (регистр не важен).
export function addressByName(data, value) {
  const needle = String(value || '').trim().toLowerCase();
  if (!needle) return null;
  return (data.reference.addresses || []).find(item =>
    item.name.toLowerCase() === needle) || null;
}

// Автоподтягивание при вводе: точное имя → начало имени → подстрока
// в имени или полном адресе. Позволяет ввести «Болошнево» и получить
// полную карточку пункта из справочника.
// Мягкое предупреждение под полем пункта: свободный текст мимо справочника
// адресов даёт неточные километраж и субъект РФ (кейс «новоиссибирск» у
// р892ху58 — опечатка увела регион машины в «Москву»). Не блокирует ввод.
function warnUnknownPlace(input, data) {
  let warn = input.parentElement.querySelector('.place-warn');
  const value = input.value.trim();
  const unknown = value && !resolveAddress(data, value);
  if (!unknown) { warn?.remove(); return; }
  if (!warn) {
    warn = document.createElement('small');
    warn.className = 'place-warn';
    input.parentElement.append(warn);
  }
  warn.textContent = '⚠ Пункт не найден в справочнике — километраж и субъект РФ будут неточными. Выберите из подсказок или добавьте адрес (кнопка «Адреса»).';
}

export function resolveAddress(data, value) {
  const needle = String(value || '').trim().toLowerCase();
  if (needle.length < 3) return null;
  const items = data.reference.addresses || [];
  return items.find(item => item.name.toLowerCase() === needle)
    || items.find(item => item.name.toLowerCase().startsWith(needle))
    || items.find(item => `${item.name} ${item.address}`.toLowerCase().includes(needle))
    || null;
}

// Пункт, набранный мимо справочника («Пенза, ул совхозная»): город — первый
// сегмент до запятой; берём любой адрес справочника этого города — регион,
// геозона и координаты будут приблизительными, но честнее ошибочной зоны
// заявки (кейс р550ту58: выгрузка в Пензе при зоне «Москва» → «в зоне»).
export function cityAddress(data, point) {
  const city = String(point || '').split(',')[0]
    .replace(/\b(г|город|гор|пос|пгт|с|д|р-н)\.?\s*$/iu, '').trim().toLowerCase();
  if (city.length < 4) return null;
  const items = data.reference.addresses || [];
  return items.find(item => item.name.toLowerCase().startsWith(city))
    || items.find(item => `${item.name} ${item.address}`.toLowerCase().includes(city))
    || null;
}

// Позиция сцепки по месту «пункт или зона»: адрес справочника (точно) →
// адрес города (приблизительно) → центр геозоны (грубо). Отдаёт регион,
// геозону и координаты для подгона — единый источник для подбора ТС.
export function placeOf(data, point, zoneName) {
  const exact = point ? resolveAddress(data, point) : null;
  if (exact) {
    return { region: exact.region || '', zoneName: exact.zone_name || zoneName || '',
      latitude: exact.latitude, longitude: exact.longitude, approx: false };
  }
  const byCity = point ? cityAddress(data, point) : null;
  if (byCity) {
    return { region: byCity.region || '', zoneName: byCity.zone_name || zoneName || '',
      latitude: byCity.latitude, longitude: byCity.longitude, approx: true };
  }
  const zone = (data.reference.zones || []).find(item => item.name === zoneName);
  return { region: regionOfPlace(data, '', zoneName), zoneName: zoneName || '',
    latitude: zone?.latitude, longitude: zone?.longitude, approx: true };
}

// Субъект РФ места «пункт или зона»: имя геозоны — самый частый субъект
// её адресов (иначе «Дом» находил бы Домодедово), затем пункт по справочнику
// (точный адрес, иначе — по городу из текста пункта).
export function regionOfPlace(data, point, zoneName) {
  const items = data.reference.addresses || [];
  const zone = String(zoneName || '').trim().toLowerCase();
  const byPoint = point ? (resolveAddress(data, point)?.region || cityAddress(data, point)?.region) : '';
  if (zone) {
    const tally = {};
    items.filter(item => (item.zone_name || '').toLowerCase() === zone && item.region)
      .forEach(item => { tally[item.region] = (tally[item.region] || 0) + 1; });
    const top = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
    if (!point && top) return top[0];
    return byPoint || (top ? top[0] : '');
  }
  return byPoint || '';
}

// Плановый километраж пары адресов: прямая по координатам × дорожный 1,2 —
// формула совпадает с серверной (roadKm в db.mjs).
export function plannedKmBetween(a, b) {
  if (!a || !b || ![a.latitude, a.longitude, b.latitude, b.longitude].every(Number.isFinite)) return null;
  const rad = value => value * Math.PI / 180;
  const h = Math.sin(rad(b.latitude - a.latitude) / 2) ** 2 +
    Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(rad(b.longitude - a.longitude) / 2) ** 2;
  return Math.round(2 * 6371 * Math.asin(Math.sqrt(h)) * 1.2);
}

// Ближайшее событие сцепки после момента погрузки: запланированный рейс
// или интервал диспозиции (пересменка, ремонт, резерв…) — подсказка при
// назначении, чтобы новый рейс не упёрся в существующий план.
export function nextVehicleEvent(data, vehicleId, fromMs) {
  const events = [];
  data.trips
    .filter(trip => trip.vehicle_id === vehicleId && trip.status !== 'rejected' &&
      Date.parse(trip.starts_at) >= fromMs)
    .forEach(trip => events.push({
      at: Date.parse(trip.starts_at),
      label: `Запланирован рейс ${routeLabel(trip)}`
    }));
  (data.dispositions || [])
    .filter(item => item.vehicle_id === vehicleId && Date.parse(item.starts_at) >= fromMs)
    .forEach(item => events.push({
      at: Date.parse(item.starts_at),
      label: DISP_KINDS.find(kind => kind.kind === item.kind)?.label || item.kind
    }));
  return events.sort((a, b) => a.at - b.at)[0] || null;
}

// Подсказка «⏭ следующее событие»: ближе двух суток к погрузке — предупреждение.
export function nextEventHint(event, fromMs) {
  if (!event) return '<small class="next-event free">⏭ дальше событий нет — сцепка свободна</small>';
  const soon = event.at - fromMs < 2 * 86_400_000;
  return `<small class="next-event ${soon ? 'warn' : ''}">⏭ ${escapeHtml(event.label)}
    · ${formatDateTime(event.at)}${soon ? ' — впритык к погрузке' : ''}</small>`;
}

// Ставка без НДС: наличная перевозка — вся сумма (НДС нет),
// безналичная — очистка по ставке клиента (ИП 7%, остальные 22%).
export function orderNet(order, data) {
  const calc = data.settings.calculation;
  if (Number(order.cash)) return Number(order.rate_vat) || 0;
  const vat = /(?<![\p{L}\p{N}])ИП(?![\p{L}\p{N}])/iu.test(order.customer_name)
    ? Number(calc.individualEntrepreneurVatRate ?? 0.07)
    : Number(calc.vatRate ?? 0.22);
  return (Number(order.rate_vat) || 0) / (1 + vat);
}

// Живой пересчёт «Без НДС» в форме: от ставки, галочки наличных и заказчика
// (ИП — 7%). Показ — по мере ввода, сохранять нечего: поле считаемое.
function wireNetField(form, netInput, data) {
  const update = () => {
    const rate = parseMoney(form.elements.rateVat?.value);
    netInput.value = rate ? money(orderNet({
      rate_vat: rate,
      cash: form.elements.cash?.checked ? 1 : 0,
      customer_name: form.elements.customerName?.value || ''
    }, data)) : '—';
  };
  form.addEventListener('input', update);
  form.addEventListener('change', update);
  update();
}

// ── Задание продажам на дату ──────────────────────────────────────────────
// Файлы, прикреплённые к потребности клиента: хелперы для карточек
// (портфель продаж, карточка рейса диспетчера) и диалога редактирования.
export const orderFilesOf = (data, orderId) =>
  (data.orderFiles || []).filter(file => file.order_id === orderId);
export const fileSizeLabel = bytes => bytes >= 1_048_576
  ? `${(bytes / 1_048_576).toFixed(1)} МБ` : `${Math.max(1, Math.round(bytes / 1024))} КБ`;
export const UPLOAD_ACCEPT = '.pdf,.png,.jpg,.jpeg,.webp,.heic,.gif,.doc,.docx,.xls,.xlsx,.csv,.txt,.rtf,.zip';
export async function uploadOrderFile(orderId, file) {
  const response = await fetch(`/api/orders/${orderId}/files`, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'X-File-Name': encodeURIComponent(file.name), 'Content-Type': 'application/octet-stream' },
    body: file
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload.file;
}
export const orderFileLinks = (data, orderId) => {
  const files = orderFilesOf(data, orderId);
  return files.length ? `<small class="order-files">${files.map(file =>
    `<a class="ofile" href="/api/order-files/${file.id}" target="_blank" rel="noopener"
      title="${escapeHtml(file.uploaded_by || '')} · ${fileSizeLabel(file.size)}">📎 ${escapeHtml(file.file_name)}</a>`).join('')}</small>` : '';
};

// Срез парка и потребностей на выбранный день: кто свободен и где, кто
// освободится (после рейса, ремонта, пересменки), кто недоступен, какие
// регионы не закрыты заявками без ТС и откуда направить ближайшие сцепки.
export function salesTaskFor(data, dayIso) {
  const dayStart = Date.parse(`${dayIso}T00:00:00Z`);
  const dayEnd = dayStart + 86_400_000;
  const addressById = id => id ? (data.reference.addresses || []).find(item => item.id === id) : null;
  const positionOf = trip => trip
    ? (resolveAddress(data, trip.to_point || trip.to_name) || null) : null;

  const free = [];        // простаивают весь день
  const freeing = [];     // освободятся в течение дня
  const unavailable = []; // недоступны весь день (ремонт/пересменка/резерв/без вод.)
  data.vehicles.filter(vehicle => vehicle.status === 'work').forEach(vehicle => {
    const trips = data.trips
      .filter(trip => trip.vehicle_id === vehicle.id && trip.status !== 'rejected')
      .sort((a, b) => a.ends_at.localeCompare(b.ends_at));
    const activeTrip = trips.find(trip =>
      Date.parse(trip.starts_at) < dayEnd && tripBusyUntilMs(trip) > dayStart);
    // Рейс, чей расчётный конец прошёл, а факта выгрузки нет, — машина ещё
    // в рейсе с неизвестным освобождением: в свободные не записывается.
    const overdueTrip = !activeTrip && trips.find(trip =>
      (trip.status === 'plan' || trip.status === 'run') && Date.parse(trip.ends_at) <= dayStart);
    const lastBefore = [...trips].reverse().find(trip => tripBusyUntilMs(trip) <= dayStart);
    const место = trip => trip ? (trip.to_point || trip.to_name) : (vehicle.zone_name || '');
    const регион = trip => trip
      ? regionOfPlace(data, trip.to_point, trip.to_name)
      : regionOfPlace(data, '', vehicle.zone_name);
    if (overdueTrip) {
      freeing.push({ vehicle, at: null, why: 'рейс дольше расчёта — уточнить у диспетчера',
        place: место(overdueTrip), region: регион(overdueTrip), position: positionOf(overdueTrip) });
      return;
    }
    if (activeTrip) {
      const busyUntil = tripBusyUntilMs(activeTrip);
      if (busyUntil <= dayEnd) {
        // Рейс опаздывает к расчётному времени — час освобождения неизвестен.
        const late = busyUntil > Date.parse(activeTrip.ends_at);
        freeing.push({ vehicle, at: late ? null : activeTrip.ends_at,
          why: late ? 'рейс дольше расчёта — уточнить у диспетчера' : 'после рейса',
          place: место(activeTrip), region: регион(activeTrip), position: positionOf(activeTrip) });
      }
      return; // занята рейсом весь день — в задание не идёт
    }
    const disps = (data.dispositions || []).filter(item => item.vehicle_id === vehicle.id &&
      Date.parse(item.starts_at) < dayEnd && Date.parse(item.ends_at) > dayStart)
      .sort((a, b) => b.ends_at.localeCompare(a.ends_at));
    const kindLabel = { repair: 'ремонта', shift: 'пересменки', no_driver: 'ожидания водителя', reserve: 'резерва' };
    if (disps.length) {
      const disp = disps[0];
      if (Date.parse(disp.ends_at) <= dayEnd) {
        freeing.push({ vehicle, at: disp.ends_at, why: `после ${kindLabel[disp.kind] || disp.kind}`,
          place: место(lastBefore), region: регион(lastBefore), position: positionOf(lastBefore) });
      } else {
        unavailable.push({ vehicle, kind: disp.kind, until: disp.ends_at });
      }
      return;
    }
    free.push({ vehicle, since: lastBefore?.ends_at || null,
      hold: (data.vehicleHolds || []).find(item => item.vehicle_id === vehicle.id) || null,
      place: место(lastBefore), region: регион(lastBefore), position: positionOf(lastBefore) });
  });
  free.sort((a, b) => String(a.since || '').localeCompare(String(b.since || '')));
  freeing.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));

  // Потребности без ТС, чьё окно накрывает день: группировка по НАПРАВЛЕНИЮ
  // (геозона погрузки → геозона выгрузки) с разбивкой по требуемым типам ТС.
  // Кузов заявки, совпадающий с типом парка («Тушевоз», «Паллет 33»…), —
  // жёсткое требование; «Рефрижератор», «Изотерм» и пустой — любой тип.
  const needs = (data.orders || []).filter(order => {
    const stage = orderStage(order, data).stage;
    return (stage === 0 || stage === 1) &&
      Date.parse(order.window_from) < dayEnd && Date.parse(order.window_to) > dayStart;
  });
  const typeNames = [...new Set(data.vehicles.map(vehicle => vehicle.type_name).filter(Boolean))];
  const ANY = 'любой реф';
  const typeOfOrder = order => typeNames.find(name =>
    name.toLowerCase() === String(order.body_type || '').trim().toLowerCase()) || ANY;
  const regionOfOrder = order => addressById(order.from_address_id)?.region
    || regionOfPlace(data, order.from_point, order.from_name);
  const freeAll = [...free, ...freeing];
  const byLane = new Map();
  needs.forEach(order => {
    const key = `${order.from_name} → ${order.to_name}`;
    if (!byLane.has(key)) {
      byLane.set(key, { lane: key, fromZone: order.from_name, toZone: order.to_name,
        fromRegion: regionOfOrder(order) || '', orders: [], byType: new Map() });
    }
    const bucket = byLane.get(key);
    bucket.orders.push(order);
    const type = typeOfOrder(order);
    bucket.byType.set(type, (bucket.byType.get(type) || 0) + 1);
  });
  const lanes = [...byLane.values()].map(bucket => {
    // Свободные в регионе погрузки по типам парка.
    const freeHere = freeAll.filter(item => item.region === bucket.fromRegion);
    const freeHereByType = new Map();
    freeHere.forEach(item => {
      const type = item.vehicle.type_name || '';
      freeHereByType.set(type, (freeHereByType.get(type) || 0) + 1);
    });
    // Дефицит: точные типы закрываются своим типом, «любой» — остатком.
    const lack = [];
    let usedExact = 0;
    for (const [type, count] of bucket.byType) {
      if (type === ANY) continue;
      const here = freeHereByType.get(type) || 0;
      usedExact += Math.min(count, here);
      if (count > here) lack.push({ type, count: count - here });
    }
    const anyNeed = bucket.byType.get(ANY) || 0;
    const anyLeft = Math.max(0, freeHere.length - usedExact);
    if (anyNeed > anyLeft) lack.push({ type: ANY, count: anyNeed - anyLeft });
    // Рекомендации: ближайшие свободные нужного типа из других регионов.
    const target = addressById(bucket.orders[0].from_address_id)
      || resolveAddress(data, bucket.orders[0].from_point || bucket.orders[0].from_name);
    const send = lack.flatMap(item => freeAll
      .filter(candidate => candidate.region !== bucket.fromRegion &&
        (item.type === ANY || candidate.vehicle.type_name === item.type))
      .map(candidate => ({ ...candidate, forType: item.type, km: (candidate.position && target)
        ? plannedKmBetween(candidate.position, target) : null }))
      .sort((a, b) => (a.km ?? 1e9) - (b.km ?? 1e9))
      .slice(0, item.count + 1));
    return { ...bucket, byType: [...bucket.byType.entries()], freeHere: freeHere.length,
      freeHereByType: [...freeHereByType.entries()].filter(([, n]) => n > 0),
      deficit: lack.reduce((sum, item) => sum + item.count, 0), lack, send };
  }).sort((a, b) => b.orders.length - a.orders.length);
  return { free, freeing, unavailable, needs, lanes };
}

// Диалог «Задание продажам»: дата выбирается, разделы пересчитываются,
// текст копируется целиком для рассылки менеджерам.
function salesTaskDialog(data, context) {
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const fmtDay = iso => new Intl.DateTimeFormat('ru-RU',
    { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${iso}T12:00:00Z`));
  const kindShort = { repair: 'ремонт', shift: 'пересменка', no_driver: 'без водителя', reserve: 'резерв' };
  const taskText = (dayIso, task) => {
    const lines = [`ЗАДАНИЕ ПРОДАЖАМ на ${fmtDay(dayIso)}`, ''];
    lines.push(`Свободны с прошлых дней: ${task.free.length}`);
    task.free.forEach(item => lines.push(`  ${item.vehicle.plate} — ${item.place}` +
      `${item.region ? ` (${item.region})` : ''}${item.since ? `, стоит с ${formatDateTime(item.since)}` : ''}`));
    lines.push('', `Освободятся в течение дня: ${task.freeing.length}`);
    task.freeing.forEach(item => lines.push(`  ${item.vehicle.plate} — ${item.at ? formatDateTime(item.at) : '⚠ время неизвестно'} ` +
      `${item.why}, ${item.place}${item.region ? ` (${item.region})` : ''}`));
    if (task.unavailable.length) {
      lines.push('', `Недоступны весь день: ${task.unavailable.length}`);
      task.unavailable.forEach(item => lines.push(`  ${item.vehicle.plate} — ` +
        `${kindShort[item.kind] || item.kind} до ${formatDateTime(item.until)}`));
    }
    lines.push('', `Перемещения — рейсов без ТС на день: ${task.needs.length}` +
      (task.needs.length ? ` · ${money(task.needs.reduce((sum, order) => sum + Number(order.rate_vat || 0), 0))}` : ''));
    task.lanes.forEach(bucket => {
      lines.push(`  ${bucket.lane}${bucket.fromRegion ? ` (погрузка: ${bucket.fromRegion})` : ''}: ` +
        `необходимо ${bucket.orders.length} — ` +
        bucket.byType.map(([type, count]) => `${count} ${type}`).join(', '));
      lines.push(`    на месте свободно: ${bucket.freeHereByType.length
        ? bucket.freeHereByType.map(([type, count]) => `${count} ${type}`).join(', ') : 'нет'}` +
        (bucket.deficit > 0
          ? ` — НЕ ХВАТАЕТ: ${bucket.lack.map(item => `${item.count} ${item.type}`).join(', ')}`
          : ' — закрывается'));
      bucket.orders.forEach(order => lines.push(`    №${order.order_no || '—'} ${order.customer_name}: ` +
        `${order.from_point || order.from_name} → ${order.to_point || order.to_name}, ` +
        `окно ${formatDateTime(order.window_from)}–${formatDateTime(order.window_to)}, ${money(order.rate_vat)}`));
      bucket.send.forEach(item => lines.push(`    → направить ${item.vehicle.plate} (${item.vehicle.type_name || ''}) из ` +
        `${item.place}${item.km != null ? ` (~${item.km} км подгон)` : ''}`));
    });
    return lines.join('\n');
  };
  const render = async dayIso => {
    const task = salesTaskFor(data, dayIso);
    // Отметки «отработано» — общие для команды, привязаны к дате задания.
    let marks = [];
    try { marks = (await api(`/api/task-marks?kind=sales&day=${dayIso}`)).items; } catch { marks = []; }
    const marked = new Map(marks.map(item => [item.item_key, item]));
    const allLanes = task.lanes;
    const doneLanes = allLanes.filter(bucket => marked.has(bucket.lane));
    task.lanes = allLanes.filter(bucket => !marked.has(bucket.lane));
    const text = taskText(dayIso, task) + (doneLanes.length
      ? `\n\nОтработано (${doneLanes.length}): ${doneLanes.map(bucket => bucket.lane).join('; ')}` : '');
    const box = document.getElementById('salesTaskBody');
    box.dataset.text = text;
    const needSum = task.needs.reduce((sum, order) => sum + Number(order.rate_vat || 0), 0);
    const lackLanes = task.lanes.filter(bucket => bucket.deficit > 0);
    const typeChips = pairs => pairs.map(([type, count]) =>
      `<span class="tt-chip">${count}&nbsp;${escapeHtml(type)}</span>`).join(' ');
    // Свободные — группами по субъекту, номера чипами: простыня не нужна.
    const freeByRegion = new Map();
    task.free.forEach(item => {
      const key = item.region || 'субъект не определён';
      if (!freeByRegion.has(key)) freeByRegion.set(key, []);
      freeByRegion.get(key).push(item);
    });
    const laneBlock = bucket => `<div class="task-lane ${bucket.deficit > 0 ? 'lack' : ''}">
      <div class="task-lane-head">
        <b>${escapeHtml(bucket.lane)}</b>
        <span class="muted">${escapeHtml(bucket.fromRegion || '')}</span>
        <span class="task-balance ${bucket.deficit > 0 ? 'bad' : 'ok'}">${bucket.deficit > 0
          ? `⛔ не хватает: ${bucket.lack.map(item => `${item.count} ${escapeHtml(item.type)}`).join(', ')}`
          : '✅ закрывается'}</span>
        <button class="button ghost small task-done-btn" data-mark="${escapeHtml(bucket.lane)}"
          title="Отметить отработанным — уйдёт в «Отработанные», отметку видит вся команда">✓</button>
      </div>
      <div class="task-lane-nums">
        <span>необходимо <b>${bucket.orders.length}</b>: ${typeChips(bucket.byType)}</span>
        <span class="muted">·</span>
        <span>на месте: ${bucket.freeHereByType.length
          ? typeChips(bucket.freeHereByType) : '<span class="muted">нет</span>'}</span>
      </div>
      ${bucket.send.length ? bucket.send.map(item => `<div class="task-row send">→ направить
        <b class="mono">${escapeHtml(item.vehicle.plate)}</b> (${escapeHtml(item.vehicle.type_name || '')})
        из ${escapeHtml(item.place)}${item.km != null
          ? ` <span class="muted">(~${item.km} км подгон)</span>` : ''}</div>`).join('') : ''}
      <details class="task-fold"><summary>заявки (${bucket.orders.length})</summary>
        ${bucket.orders.map(order => `<div class="task-row">📦 №${escapeHtml(order.order_no || '—')}
          ${escapeHtml(order.customer_name)} · ${escapeHtml(order.from_point || order.from_name)} →
          ${escapeHtml(order.to_point || order.to_name)} · ${money(order.rate_vat)}
          ${order.body_type ? `<span class="muted">· ${escapeHtml(order.body_type)}</span>` : ''}</div>`).join('')}
      </details>
    </div>`;
    box.innerHTML = `
      <div class="task-kpis">
        <div class="task-kpi"><b>${task.free.filter(item => !item.hold).length}</b><span>свободны без брони${task.free.some(item => item.hold) ? ` · 🔒 ${task.free.filter(item => item.hold).length}` : ''}</span></div>
        <div class="task-kpi"><b>${task.freeing.length}</b><span>освободятся</span></div>
        <div class="task-kpi muted"><b>${task.unavailable.length}</b><span>недоступны</span></div>
        <div class="task-kpi ${lackLanes.length ? 'warn' : ''}"><b>${task.needs.length}</b>
          <span>рейсов без ТС · ${money(needSum)}</span></div>
      </div>
      <div class="task-sec"><b>Перемещения на дату (${task.lanes.length} направлений${lackLanes.length
          ? ` · <span class="danger">дефицит: ${lackLanes.length}</span>` : ''})</b>
        ${[...lackLanes, ...task.lanes.filter(bucket => !bucket.deficit)].map(laneBlock).join('')
          || '<p class="muted">рейсов без ТС на день нет</p>'}</div>
      ${doneLanes.length ? `<details class="task-fold task-done-list">
        <summary>✓ Отработанные направления (${doneLanes.length})</summary>
        ${doneLanes.map(bucket => `<div class="task-row done">✓ ${escapeHtml(bucket.lane)} ·
          ${bucket.orders.length} заявок <span class="muted">· ${escapeHtml(marked.get(bucket.lane)?.done_by || '')}</span>
          <button class="button ghost small" data-mark="${escapeHtml(bucket.lane)}" title="Вернуть в задание">↩</button>
        </div>`).join('')}
      </details>` : ''}
      <div class="task-sec"><b>Свободны с прошлых дней (${task.free.length})</b>
        ${[...freeByRegion.entries()].sort((a, b) => b[1].length - a[1].length).map(([region, list]) =>
          `<details class="task-fold"><summary>${escapeHtml(region)} — <b>${list.length}</b></summary>
            <div class="task-chips">${list.map(item => `<span class="tt-chip mono" ${item.hold ? 'style="opacity:.55"' : ''}
              title="${escapeHtml(item.place)}${item.since ? ` · стоит с ${formatDateTime(item.since)}` : ''}${item.hold ? ` · 🔒 бронь: ${escapeHtml(item.hold.held_by_name)}${item.hold.note ? ` — ${escapeHtml(item.hold.note)}` : ''}` : ''}">${item.hold ? '🔒 ' : ''}${escapeHtml(item.vehicle.plate)}</span>`).join(' ')}</div>
          </details>`).join('') || '<p class="muted">нет</p>'}</div>
      <div class="task-sec"><b>Освободятся в течение дня (${task.freeing.length})</b>
        ${task.freeing.map(item => `<div class="task-row">⏱ <b>${item.at ? formatDateTime(item.at) : '⚠'}</b>
          <b class="mono">${escapeHtml(item.vehicle.plate)}</b> ${escapeHtml(item.why)} —
          ${escapeHtml(item.place)}${item.region ? ` <span class="muted">(${escapeHtml(item.region)})</span>` : ''}</div>`).join('')
          || '<p class="muted">нет</p>'}</div>
      <div class="task-sec"><b>Недоступны весь день (${task.unavailable.length})</b>
        <div class="task-chips">${task.unavailable.map(item => `<span class="tt-chip muted"
          title="до ${formatDateTime(item.until)}">${escapeHtml(item.vehicle.plate)} · ${escapeHtml(kindShort[item.kind] || item.kind)}</span>`).join(' ')
          || '<span class="muted">нет</span>'}</div></div>`;
    box.querySelectorAll('[data-mark]').forEach(button =>
      button.addEventListener('click', async () => {
        try {
          await api('/api/task-marks', { method: 'POST',
            body: JSON.stringify({ kind: 'sales', day: dayIso, key: button.dataset.mark }) });
          await render(dayIso);
        } catch (error) { toast(error.message, 'error'); }
      }));
  };
  context.showModal(`<h2 style="margin-bottom:6px">📋 Задание продажам</h2>
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px">
      ${dayPickerHtml('salesTaskDay', tomorrow, 'на дату')}
      <button class="button small" id="salesTaskCopy" style="margin-left:auto">📋 Скопировать</button>
    </div>
    <div id="salesTaskBody" style="max-height:62vh;overflow:auto"></div>`);
  const modal = document.querySelector('#modalRoot .modal');
  if (modal) modal.style.width = 'min(820px, 96vw)';
  render(tomorrow);
  wireDayPicker(document, 'salesTaskDay', value => render(value));
  document.getElementById('salesTaskCopy').onclick = async () => {
    const text = document.getElementById('salesTaskBody').dataset.text || '';
    try { await navigator.clipboard.writeText(text); } catch {
      const area = document.createElement('textarea');
      area.value = text; document.body.append(area);
      area.select(); document.execCommand('copy'); area.remove();
    }
    toast('Задание скопировано');
  };
}

function routeInfo(data, fromId, toId) {
  const rates = data.reference.routeRates;
  const rate = rates.find(item => item.from_zone_id === fromId && item.to_zone_id === toId)
    || rates.find(item => item.from_zone_id === toId && item.to_zone_id === fromId);
  const settings = data.settings.calculation;
  const distance = Number(rate?.distance_km || 500);
  const transit = transitHours(distance, settings) / 24;
  return { distance, transit, rate: Number(rate?.default_rate_vat || Math.round(distance * 120)) };
}

// Освобождающиеся сцепки: последний рейс ТС заканчивается до конца месяца —
// сцепке нужен обратный груз из зоны выгрузки.
// ТС в ремонте или без водителя в потребность не попадает: предлагать её
// клиентам рано. Появляется за сутки до окончания диспозиции с пометкой
// «выйдет из ремонта / получит водителя такого-то числа — требуется загрузка».
export function autoRequests(data, monthStartDate, monthEndDate) {
  const requests = [];
  const nowMs = Date.now();
  const zoneByName = Object.fromEntries(data.reference.zones.map(zone => [zone.name, zone]));
  // Субъект РФ, где сцепка освобождается: адрес выгрузки заявки последнего
  // рейса, иначе пункт выгрузки рейса по справочнику адресов.
  const addressById = id => id ? (data.reference.addresses || []).find(item => item.id === id) : null;
  const regionOfTrip = trip => {
    if (!trip) return '';
    const order = trip.order_id
      ? (data.orders || []).find(item => item.id === trip.order_id) : null;
    const byOrder = order ? addressById(order.to_address_id)?.region : '';
    if (byOrder) return byOrder;
    return regionOfPlace(data, trip.to_point, trip.to_name);
  };
  data.vehicles.filter(vehicle => vehicle.status === 'work').forEach(vehicle => {
    const trips = data.trips
      .filter(trip => trip.vehicle_id === vehicle.id && trip.status !== 'rejected')
      .sort((a, b) => a.ends_at.localeCompare(b.ends_at));
    const last = trips[trips.length - 1] || null;
    // Незавершённый рейс держит сцепку до факта выгрузки; расчётный конец
    // в прошлом — не «стоит», а «рейс дольше расчёта» (пометка для логиста).
    const tripFreeMs = last ? tripBusyUntilMs(last, nowMs) : 0;
    const overdueTrip = last && (last.status === 'plan' || last.status === 'run') &&
      Date.parse(last.ends_at) < nowMs;
    // Блокирующие интервалы (ремонт, без водителя, резерв под заказ),
    // заканчивающиеся позже рейса: сцепка реально доступна после самого
    // позднего из них. Резерв — сцепка обещана, продажам не предлагается.
    const blocking = (data.dispositions || []).filter(item =>
      item.vehicle_id === vehicle.id && ['repair', 'no_driver', 'reserve'].includes(item.kind) &&
      Date.parse(item.ends_at) > Math.max(tripFreeMs, nowMs - 86_400_000));
    const blockEndMs = blocking.length ? Math.max(...blocking.map(item => Date.parse(item.ends_at))) : 0;
    // До выхода из ремонта/появления водителя больше суток — не потребность.
    if (blockEndMs > nowMs + 86_400_000) return;
    const blocked = blockEndMs > nowMs
      ? blocking.find(item => Date.parse(item.ends_at) === blockEndMs) : null;
    const endsAt = new Date(Math.max(tripFreeMs, blockEndMs));
    if (!tripFreeMs && !blockEndMs) return;
    // Уже простаивающие показываются независимо от месяца последнего рейса
    // (июльские хвосты — самый долгий и дорогой простой); будущие
    // освобождения — в пределах открытого месяца.
    const idleMs = nowMs - endsAt.getTime();
    if (idleMs <= 0 && (endsAt >= monthEndDate || endsAt < monthStartDate)) return;
    const zone = zoneByName[last?.to_name] || zoneByName[vehicle.zone_name];
    if (!zone) return;
    // Предложение обратного груза: самое доходное направление из зоны выгрузки.
    const lanes = data.reference.routeRates
      .filter(rate => rate.from_zone_id === zone.id)
      .sort((a, b) => b.default_rate_vat - a.default_rate_vat);
    const suggestion = lanes[0];
    const customer = suggestion
      ? data.trips.find(trip => trip.from_name === zone.name && trip.to_name === suggestion.to_name)?.customer_name
      : null;
    requests.push({
      vehicle, zone,
      region: regionOfTrip(last),
      overdueTrip,
      // Последний рейс ещё в работе, а следующего нет — нарушение правила
      // «у машины на линии назначен следующий рейс».
      nextMissing: Boolean(last && (last.status === 'plan' || last.status === 'run')),
      freeAt: endsAt.toISOString(),
      // Простой: сцепка уже стоит без загрузки (idleMs > 0) — приоритет продаж.
      idleMs: Math.max(0, idleMs),
      // «Выйдет из ремонта / получит водителя» — пометка для менеджера.
      blockedKind: blocked?.kind || null,
      blockedUntil: blocked?.ends_at || null,
      // Погрузка возможна не раньше подачи (норматив после выгрузки);
      // для уже простаивающих — от текущего момента. Окно — до конца вторых суток.
      loadFrom: new Date(Math.max(endsAt.getTime(), nowMs) + DISPATCH_LAG_MS).toISOString(),
      windowTo: new Date(Math.min(
        atHour(new Date(Math.max(endsAt.getTime(), nowMs) + 2 * 86_400_000), WORK_END_HOUR).getTime(),
        monthEndDate.getTime()
      )).toISOString(),
      suggestTo: suggestion?.to_name || null,
      suggestToId: suggestion?.to_zone_id || null,
      suggestRate: suggestion?.default_rate_vat || 0,
      suggestCustomer: customer || ''
    });
  });
  return requests.sort((a, b) => a.freeAt.localeCompare(b.freeAt));
}

// Кандидаты на назначение: свободные в зоне отправления к началу окна, затем ближайшие.
// Занятость определяется точным пересечением по времени — две заявки в один день
// с разным временем погрузки не конфликтуют.
export function matchVehicles(data, fromZoneName, windowFrom, fromAddress = null) {
  const moment = Date.parse(windowFrom);
  // Позиция кандидата — место выгрузки последнего рейса: адрес справочника,
  // иначе город из текста пункта, иначе центр геозоны (placeOf). Регион
  // заявки — по адресу погрузки; геозоне рейса одной не верим: заявка
  // бывает вбита с чужой зоной (р550ту58: выгрузка в Пензе при зоне «Москва»).
  const orderRegion = fromAddress?.region || regionOfPlace(data, '', fromZoneName);
  const busy = new Set(data.trips
    .filter(trip => trip.status !== 'rejected' &&
      Date.parse(trip.starts_at) <= moment && tripBusyUntilMs(trip) > moment)
    .map(trip => trip.vehicle_id));
  // Недоступные на момент погрузки (ремонт, без водителя, пересменка, выведена)
  // и зарезервированные под другой заказ кандидатами не предлагаются —
  // та же логика, что и в потребности от логистики.
  const blocked = new Set((data.dispositions || [])
    .filter(item => Date.parse(item.starts_at) <= moment && moment < Date.parse(item.ends_at))
    .map(item => item.vehicle_id));
  return data.vehicles
    .filter(vehicle => vehicle.status === 'work' && !busy.has(vehicle.id) && !blocked.has(vehicle.id))
    .map(vehicle => {
      const lastTrip = data.trips
        .filter(trip => trip.vehicle_id === vehicle.id && trip.status !== 'rejected' &&
          tripBusyUntilMs(trip) <= moment)
        .sort((a, b) => b.ends_at.localeCompare(a.ends_at))[0];
      const place = lastTrip
        ? placeOf(data, lastTrip.to_point, lastTrip.to_name)
        : placeOf(data, '', vehicle.zone_name);
      const zoneName = place.zoneName || (lastTrip ? lastTrip.to_name : vehicle.zone_name);
      // «В зоне»: геозона совпадает И регион позиции не противоречит региону
      // погрузки (когда оба известны) — регион точнее зоны.
      const inZone = zoneName === fromZoneName &&
        !(orderRegion && place.region && orderRegion !== place.region);
      // Порожний подгон: от позиции сцепки до адреса погрузки заявки.
      const emptyKm = fromAddress ? plannedKmBetween(place, fromAddress) : null;
      // Готовность к подаче: 2 ч + время подгона (порожние км ÷ 50 км/ч).
      const feedMs = DISPATCH_LAG_MS + (emptyKm ? emptyKm / 50 * 3_600_000 : 0);
      const readyAt = lastTrip ? tripBusyUntilMs(lastTrip) + feedMs : null;
      // Сцепка ещё едет (факта выгрузки нет) — освобождение расчётное, риск опоздания.
      const stillRunning = Boolean(lastTrip && (lastTrip.status === 'plan' || lastTrip.status === 'run'));
      return {
        vehicle, zoneName, inZone, emptyKm, region: place.region, approx: place.approx,
        lastTrip, stillRunning,
        readyAt, ready: !readyAt || readyAt <= moment
      };
    })
    .sort((a, b) => Number(b.inZone) - Number(a.inZone) ||
      (a.emptyKm ?? Infinity) - (b.emptyKm ?? Infinity) ||
      Number(b.ready) - Number(a.ready));
}

// Единый предикат фильтра доски продаж: зона участвует в маршруте, окно
// погрузки пересекает диапазон, текст поиска найден в заказчике или маршруте.
// Используется и при отрисовке, и при проверке видимости заявки после
// создания/копии/правки — логика обязана совпадать.
function salesFilterPredicate(data, filter) {
  const addressById = id => id ? (data.reference.addresses || []).find(item => item.id === id) : null;
  const orderRegions = order => [addressById(order.from_address_id)?.region,
    addressById(order.to_address_id)?.region].filter(Boolean);
  const query = String(filter.q || '').toLowerCase();
  return order =>
    (!filter.zone || order.from_name === filter.zone || order.to_name === filter.zone) &&
    (!filter.region || orderRegions(order).includes(filter.region)) &&
    (!filter.from || String(order.window_to).slice(0, 10) >= filter.from) &&
    (!filter.to || String(order.window_from).slice(0, 10) <= filter.to) &&
    (!query || `${order.customer_name} ${routeLabel(order)} ${order.order_no || ''} ${order.rejection_reason || ''}`
      .toLowerCase().includes(query));
}

// После «Забронировать», «⧉ Копия» и правки карточка обязана остаться на
// глазах у сотрудника. Если активный фильтр доски её прячет (например,
// пресет «Сегодня», а погрузка завтра) — заявка «пропадает практически
// сразу», сотрудник вбивает её заново и в портфеле копятся дубли
// (кейс 24.08: шесть заявок «Останкино» за пять минут). Поэтому перед
// перерисовкой фильтр снимается с пояснением. Вызывать ДО onReload().
function dropFilterIfHides(state, orderLike, orderNo) {
  // Правка может открываться и вне вкладки продаж (карточка рейса в app.js) —
  // там контекст без state и фильтра доски нет, прятать нечего.
  const filter = state?.salesFilter;
  if (!filter) return;
  if (salesFilterPredicate(state.data, filter)(orderLike)) return;
  state.salesFilter = { zone: '', region: '', from: '', to: '', q: '' };
  toast(`Заявка № ${orderNo || '—'} не проходила фильтр доски — фильтр сброшен, карточка в списке`);
}

export async function renderSales(container, context) {
  const { state, can } = context;
  const data = state.data;
  const monthEnd = new Date(Date.UTC(state.month.getUTCFullYear(), state.month.getUTCMonth() + 1, 1));
  // Фильтр доски: геозона + диапазон дат (хранится в state, переживает перерисовки).
  const filter = state.salesFilter || (state.salesFilter = { zone: '', region: '', from: '', to: '', q: '' });
  const regionList = [...new Set((data.reference.addresses || [])
    .map(item => item.region).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'));
  filter.q ||= '';
  const matchesFilter = salesFilterPredicate(data, filter);
  // Портфель продаж — заявки до назначения ТС: после назначения заявка уходит
  // к логисту в план и возвращается только при отклонении рейса.
  // Отклонённые (cancelled с причиной) — в отдельном реестре ниже.
  const allOrders = data.orders.filter(order => inSalesPortfolio(order, data));
  const orders = allOrders.filter(matchesFilter);
  // Удалённые (deleted_at) в оперативном реестре не показываются —
  // они остаются в БД и видны в отчёте «Реестр заявок» для аналитики.
  const rejectedOrders = data.orders
    .filter(order => order.status === 'cancelled' && !order.deleted_at)
    .filter(matchesFilter);
  // «В плане у логиста» — ушедшие из портфеля: ТС назначено, рейс не отклонён.
  const assigned = data.orders.filter(order =>
    order.status !== 'cancelled' && orderStage(order, data).stage === 2).length;
  const returned = orders.filter(order => order.returned_at).length;
  const awaitingAssign = orders.filter(order => orderStage(order, data).stage === 1).length;
  const tasks = myTasks(orders, data, can);
  const onlyMine = Boolean(state.salesOnlyMine);
  const filterActive = filter.zone || filter.region || filter.from || filter.to || filter.q;
  const zoneOptions = data.reference.zones.map(zone => `<option value="${zone.id}">${escapeHtml(zone.name)}</option>`).join('');
  const orderOptions = data.settings.orderOptions || {};
  const temps = (orderOptions.temperatureModes || []).map(item => `<option>${escapeHtml(item)}</option>`).join('');
  const bodies = (orderOptions.bodyTypes || []).map(item => `<option>${escapeHtml(item)}</option>`).join('');

  // ── Клиенты: живые заказы (до выгрузки) по заказчикам — с учётом фильтров ──
  // Заказ попадает в карточку клиента сразу после внесения и ждёт там
  // подтверждения; неподтверждённый ближе 8 часов к погрузке — горит
  // (сервер шлёт продажам сигнал в чат каждые 30 минут до подтверждения).
  const HOT_MS = 8 * 3_600_000;
  const nowTs = Date.now();
  const liveOrders = data.orders.filter(order => order.status !== 'cancelled' && !order.deleted_at &&
    orderStage(order, data).stage < 4 && matchesFilter(order));
  const isUnconfirmed = order => Number(order.stage) === 0 && !order.trip_id;
  const isHotUnconfirmed = order => isUnconfirmed(order) && Date.parse(order.window_from) - nowTs < HOT_MS;
  const clientsMap = new Map();
  for (const order of liveOrders) {
    if (!clientsMap.has(order.customer_name)) clientsMap.set(order.customer_name, []);
    clientsMap.get(order.customer_name).push(order);
  }
  const clients = [...clientsMap].map(([name, list]) => {
    const sorted = list.sort((a, b) => String(a.window_from).localeCompare(String(b.window_from)));
    return {
      name, orders: sorted,
      unconfirmed: sorted.filter(isUnconfirmed).length,
      hot: sorted.filter(isHotUnconfirmed).length,
      planned: sorted.filter(order => orderStage(order, data).stage >= 2).length,
      first: sorted[0].window_from, last: sorted[sorted.length - 1].window_from,
      sum: sorted.reduce((sum, order) => sum + Number(order.rate_vat || 0), 0)
    };
  }).sort((a, b) => b.hot - a.hot || b.unconfirmed - a.unconfirmed ||
    String(a.first).localeCompare(String(b.first)));
  const unconfirmedTotal = clients.reduce((sum, client) => sum + client.unconfirmed, 0);
  const hotTotal = clients.reduce((sum, client) => sum + client.hot, 0);
  const fmtDay = value => new Date(value).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const hotLabel = order => {
    const leftMs = Date.parse(order.window_from) - nowTs;
    if (leftMs <= 0) return 'время погрузки прошло';
    return `погрузка через ${Math.floor(leftMs / 3_600_000)} ч ${Math.round((leftMs % 3_600_000) / 60_000)} мин`;
  };

  const stepper = stage => `<div class="stepper">${STAGES.map((_, index) =>
    `<span class="stp ${index <= stage ? 'on' : ''}"></span>`).join('')}<span class="stpl">${STAGES[stage] || STAGES[0]}</span></div>`;

  // Карточка конвейера: стадия, чей ход, сколько ждёт и кнопка действия.
  // Приоритет — заявки на подтверждении (стадия «Принята», ход продаж):
  // всегда сверху; после подтверждения карточка уходит в общий список,
  // где новые сверху и позиция стабильна (иначе при большом портфеле
  // карточку «теряли» и создавали дубли).
  const canReject = can('orders:write') || can('trips:write');
  const withStep = orders.map(order => ({ order, step: pipelineStep(order, data, can) }));
  const needsConfirm = item => Number(item.order.stage) === 0;
  const visible = (onlyMine ? withStep.filter(item => item.step.mine) : withStep)
    .sort((a, b) => Number(needsConfirm(b)) - Number(needsConfirm(a)) ||
      String(b.order.created_at).localeCompare(String(a.order.created_at)));

  const orderCardHtml = ({ order, step }) => {
    const waiting = step.waitingRole
      ? (step.mine ? '<span class="pipe-badge mine">Ваш ход</span>'
        : `<span class="pipe-badge">Ждёт: ${escapeHtml(step.waitingRole)}</span>`)
      : '<span class="pipe-badge done">Закрыта</span>';
    const since = step.sinceMs > 3_600_000 && step.waitingRole
      ? `<span class="pipe-since ${step.sinceMs > 2 * 86_400_000 ? 'stale' : ''}">${waitingLabel(step.sinceMs)}</span>` : '';
    const action = step.action && step.mine
      ? `<button class="button small" data-act="${step.action.kind}" data-order="${order.id}"
          ${step.action.status ? `data-status="${step.action.status}"` : ''}
          title="${escapeHtml(step.action.hint || '')}">${escapeHtml(step.action.label)}</button>`
      : '';
    const reassign = step.hot && can('trips:write')
      ? `<button class="button small danger" data-act="assign" data-order="${order.id}">⚠ Переназначить ТС</button>` : '';
    return `<div class="list-item ordrow pipe-${step.tone}" data-order="${order.id}">
      <span style="flex:1;min-width:0">
        <strong>${escapeHtml(order.customer_name)}</strong> · ${escapeHtml(routeLabel(order))}
        ${step.plate ? ` · <span class="mono">${escapeHtml(step.plate)}</span>` : ''}
        ${Number(order.cash) ? '<span class="cash-badge">💵 наличные</span>' : ''}
        <small class="muted" style="display:block">${order.order_no ? `№ ${escapeHtml(order.order_no)} · ` : ''}${escapeHtml(order.body_type || 'Рефрижератор')} · ${escapeHtml(order.temperature_mode || '—')}${order.planned_km ? ` · 📏 ${Math.round(order.planned_km)} км` : ''}${(() => {
          try { const viaList = JSON.parse(order.via_json || '[]');
            return viaList.length ? ` · ⛳ ${viaList.length} пром.` : ''; } catch { return ''; } })()} · окно ${fmtDateTime(order.window_from)} → ${fmtDateTime(order.window_to)}</small>
        ${order.comment ? `<small class="muted" style="display:block">💬 ${escapeHtml(order.comment)}</small>` : ''}
        ${orderFileLinks(data, order.id)}
        ${order.returned_at ? `<small class="returned-note">↩ вернулась из плана: ${escapeHtml(order.rejection_reason || 'без причины')}</small>` : ''}
        ${isHotUnconfirmed(order) ? `<small class="hot-note">🔥 Не подтверждена — ${hotLabel(order)}. Подтвердите или отклоните</small>` : ''}
        <div class="stepper-row">${stepper(step.stage)}<span class="pipe-inline">${waiting}${since}</span></div>
      </span>
      <span style="display:flex;flex-direction:column;gap:5px;align-items:flex-end">
        <b>${money(order.rate_vat)}</b>
        <small class="muted">${Number(order.cash) ? 'наличные · без НДС'
          : `б. НДС ${money(orderNet(order, data))}`}</small>
        ${reassign || action}
        <span style="display:flex;gap:5px">
          ${can('orders:write') ? `<button class="button ghost small" data-edit-order="${order.id}"
            title="Изменить потребность: заказчик, пункты, окно, ставка">Изменить</button>
          <button class="button ghost small" data-copy-order="${order.id}"
            title="Создать копию заявки с новым № — под повторный рейс; откроется на правку">⧉ Копия</button>` : ''}
          ${step.canReject ? `<button class="button ghost small" data-act="reject" data-order="${order.id}">Отклонить</button>` : ''}
        </span>
      </span>
    </div>`;
  };
  const portfolio = visible.map(orderCardHtml).join('')
    || `<p class="muted">${onlyMine ? 'Задач для вас нет — конвейер ждёт другие роли.' : 'Потребностей клиента пока нет — заполните форму справа.'}</p>`;

  // Карточки клиентов: клик раскрывает все заказы клиента хронологически.
  const clientCard = client => {
    const open = state.salesClientOpen === client.name;
    return `<div class="list-item client-card ${open ? 'open' : ''} ${client.hot ? 'pipe-returned' : ''}"
        data-client="${escapeHtml(client.name)}" title="Все заказы клиента в хронологическом порядке">
      <span style="flex:1;min-width:0">
        <strong>${escapeHtml(client.name)}</strong>
        <small class="muted" style="display:block">заказов ${client.orders.length}
          · ${fmtDay(client.first)}${client.first !== client.last ? ` — ${fmtDay(client.last)}` : ''}
          · ${money(client.sum)}</small>
        <span class="client-badges">
          ${(() => {
            const bday = (data.customerDates || []).find(item => item.kind === 'birthday' && item.customer === client.name);
            return bday ? `<span class="badge" title="День рождения контакта — поздравьте">🎂 ${escapeHtml(bday.contact)} ${bday.daysLeft === 0 ? 'сегодня' : bday.daysLeft === 1 ? 'завтра' : `через ${bday.daysLeft} дн.`}</span>` : '';
          })()}
          ${client.hot ? `<span class="badge bad">🔥 подтвердить ${client.hot} — погрузка ближе 8 ч</span>` : ''}
          ${client.unconfirmed - client.hot > 0 ? `<span class="badge warn">ждут подтверждения ${client.unconfirmed - client.hot}</span>` : ''}
          ${client.planned ? `<span class="badge ok">в плане / в пути ${client.planned}</span>` : ''}
        </span>
      </span>
      <span style="display:flex;gap:6px;align-items:center">
        <button type="button" class="button ghost small" data-client-card="${escapeHtml(client.name)}"
          title="Карточка клиента: сводка, контакты и дни рождения, журнал касаний, заказы, реквизиты">📇</button>
        <span class="muted">${open ? '▾' : '▸'}</span>
      </span>
    </div>
    ${open ? `<div class="client-orders">${client.orders.map(order =>
      orderCardHtml({ order, step: pipelineStep(order, data, can) })).join('')}</div>` : ''}`;
  };
  const clientsList = clients.map(clientCard).join('')
    || '<p class="muted">Живых заказов нет — внесите потребность клиента в форме справа.</p>';

  // Реестр отклонённых: заявки, на которые ТС так и не назначили.
  const rejectedList = rejectedOrders.map(order => `<div class="list-item ordrow rejected-order">
      <span style="flex:1;min-width:0">
        <strong>${escapeHtml(order.customer_name)}</strong> · ${escapeHtml(routeLabel(order))}
        <small class="muted" style="display:block">окно ${fmtDateTime(order.window_from)} → ${fmtDateTime(order.window_to)} · ${money(order.rate_vat)}</small>
        <small class="reject-note">✕ ${escapeHtml(order.rejection_reason || 'без причины')}</small>
      </span>
      <span style="display:flex;gap:5px">
        ${canReject ? `<button class="button ghost small" data-restore="${order.id}">Вернуть в работу</button>` : ''}
        ${can('orders:write') ? `<button class="button ghost small danger" data-delete-order="${order.id}"
          title="Убрать из оперативного реестра; для аналитики останется в отчёте «Реестр заявок»">Удалить</button>` : ''}
      </span>
    </div>`).join('') || '<p class="muted">Отклонённых заявок нет.</p>';

  // Оперативная сводка (переехала из боковой панели Ганта): считается только
  // по текущему открытому периоду — рейсы, завершающиеся в выбранном месяце,
  // прошлые периоды (июль) в цифры не попадают.
  const calc = data.settings.calculation;
  // Оперативная сводка — всегда ТЕКУЩИЙ календарный месяц: листание
  // горизонта планера не должно подменять продажам актуальные цифры.
  const nowRef = new Date();
  const curMonthStart = new Date(Date.UTC(nowRef.getUTCFullYear(), nowRef.getUTCMonth(), 1));
  const curMonthEnd = new Date(Date.UTC(nowRef.getUTCFullYear(), nowRef.getUTCMonth() + 1, 1));
  const periodTrips = data.trips.filter(trip => trip.status !== 'rejected' &&
    new Date(trip.ends_at) >= curMonthStart && new Date(trip.ends_at) < curMonthEnd);
  const periodNet = periodTrips.reduce((sum, trip) => {
    const vat = trip.cash ? 0 : /(?<![\p{L}\p{N}])ИП(?![\p{L}\p{N}])/iu.test(trip.customer_name)
      ? Number(calc.individualEntrepreneurVatRate ?? 0.07) : Number(calc.vatRate ?? 0.22);
    return sum + trip.revenue_vat / (1 + vat);
  }, 0);
  const periodLabel = new Intl.DateTimeFormat('ru-RU', { month: 'long', timeZone: 'UTC' }).format(curMonthStart);
  // Заявки с истёкшим окном — требуют передоговорить сроки или отклонить:
  // в подбор конструктора и назначение они уже не встают.
  const expiredOrders = allOrders.filter(order =>
    orderStage(order, data).stage < 2 && Date.parse(order.window_to) < Date.now());

  // Плашки-KPI кликабельны: выпадающий список позиций категории,
  // выбор заявки открывает редактирование (суммы, времена и остальное).
  // «В плане у логиста» — только назначенные, ещё не выехавшие (stage 2):
  // выгруженные и завершённые заявки — история, ей место в отчётах.
  const inPlanOrders = data.orders
    .filter(order => order.status !== 'cancelled' && orderStage(order, data).stage === 2)
    .filter(matchesFilter)
    .sort((a, b) => String(a.window_from).localeCompare(String(b.window_from)));
  const inRunCount = data.orders.filter(order =>
    order.status !== 'cancelled' && orderStage(order, data).stage === 3).length;
  const kpiDrop = (key, rows) => state.salesKpiOpen === key
    ? `<div class="skpi-drop">${rows || '<div class="skpi-row muted">Пусто</div>'}</div>` : '';
  const orderRow = order => {
    const trip = order.trip_id ? data.trips.find(item => item.id === order.trip_id) : null;
    return `<div class="skpi-row" data-kpi-order="${order.id}">
      <span style="flex:1;min-width:0"><strong>${escapeHtml(order.customer_name)}</strong> · ${escapeHtml(routeLabel(order))}
        ${Number(order.cash) ? '<span class="cash-badge">💵 наличные</span>' : ''}
        <small class="muted" style="display:block">${order.order_no ? `№ ${escapeHtml(order.order_no)} · ` : ''}окно ${fmtDateTime(order.window_from)} → ${fmtDateTime(order.window_to)}
          ${trip ? ` · <span class="mono">${escapeHtml(trip.vehicle_plate || '')}</span>` : ''}</small></span>
      <b>${money(order.rate_vat)}</b></div>`;
  };
  // Вопросы водителей, где сбой на стороне продаж: данные не ушли
  // грузоотправителю, не тот адрес, нужен телефон клиента.
  const questions = questionsForOwner(await loadOpenQuestions(), 'Продажи');
  const savedScrolls = captureScrolls(container);
  const html = `<div class="saleswrap">
    ${questionsStripHtml(questions, { title: '📞 Вопросы водителей — продажам', compact: true, open: state.salesQuestionsOpen })}
    <div class="salekpis">
      <div class="skpi clickable ${state.salesKpiOpen === 'clients' ? 'open' : ''} ${hotTotal ? 'skpi-hot' : ''}" data-kpi="clients"
        title="Клиенты с живыми заказами — выбор раскрывает клиента в левой колонке">
        <span class="skl">Клиенты</span><span class="skv">${clients.length}</span>
        <small class="skm">${unconfirmedTotal ? `ждут подтверждения ${unconfirmedTotal}${hotTotal ? ` · 🔥 ${hotTotal}` : ''}` : 'всё подтверждено'}</small>
        ${kpiDrop('clients', clients.map(client => `<div class="skpi-row" data-kpi-client="${escapeHtml(client.name)}">
          <span style="flex:1;min-width:0"><strong>${escapeHtml(client.name)}</strong>
            <small class="muted" style="display:block">заказов ${client.orders.length} · ${fmtDay(client.first)}</small></span>
          ${client.hot ? '🔥' : client.unconfirmed ? '⏳' : ''}</div>`).join(''))}</div>
      <div class="skpi clickable ${state.salesKpiOpen === 'portfolio' ? 'open' : ''}" data-kpi="portfolio"
        title="Заявки портфеля — выбор открывает редактирование">
        <span class="skl">Потребность клиента</span><span class="skv">${orders.length}${filterActive ? `<small class="muted"> / ${allOrders.length}</small>` : ''}</span>
        ${kpiDrop('portfolio', orders.map(orderRow).join(''))}</div>
      <div class="skpi clickable ${state.salesKpiOpen === 'awaiting' ? 'open' : ''}" data-kpi="awaiting"
        title="Подтверждённые без ТС — выбор открывает редактирование">
        <span class="skl">Ждут назначения ТС</span><span class="skv">${awaitingAssign}</span>
        ${kpiDrop('awaiting', orders.filter(order => orderStage(order, data).stage === 1).map(orderRow).join(''))}</div>
      <div class="skpi clickable ${state.salesKpiOpen === 'logist' ? 'open' : ''}" data-kpi="logist"
        title="Назначено, рейс ещё не выехал — выбор открывает редактирование; выгруженные и завершённые — в отчётах">
        <span class="skl">В плане у логиста</span><span class="skv">${assigned}</span>
        <small class="skm">в пути ${inRunCount}</small>
        ${kpiDrop('logist', inPlanOrders.map(orderRow).join(''))}</div>
      <div class="skpi clickable ${state.salesKpiOpen === 'expired' ? 'open' : ''} ${expiredOrders.length ? 'skpi-hot' : ''}"
        data-kpi="expired" title="Окно погрузки истекло, ТС не назначено: передоговорите сроки («Изменить») или отклоните — в подбор такие заявки не встают">
        <span class="skl">⚠ Окно истекло</span><span class="skv">${expiredOrders.length}</span>
        ${kpiDrop('expired', expiredOrders.map(orderRow).join(''))}</div>
      <div class="skpi" title="Выручка без НДС по рейсам, завершённым в текущем календарном месяце (не зависит от листания периода; НДС ИП — 7%)">
        <span class="skl">Выручка б. НДС · ${escapeHtml(periodLabel)}</span><span class="skv">${money(periodNet)}</span>
        <small class="skm">${periodTrips.length} рейсов завершено</small></div>
      ${demurrageChipHtml(data)}
      <div class="salesfilter">
        <span class="skl">Фильтр</span>
        <input id="salesSearch" class="block-search" placeholder="Поиск: заказчик, маршрут, ТС"
          value="${escapeHtml(filter.q)}">
        <select id="salesFilterZone">
          <option value="">Все геозоны</option>
          ${data.reference.zones.map(zone =>
            `<option value="${escapeHtml(zone.name)}" ${filter.zone === zone.name ? 'selected' : ''}>${escapeHtml(zone.name)}</option>`).join('')}
        </select>
        <select id="salesFilterRegion" title="Субъект РФ — по адресам погрузки/выгрузки заявки">
          <option value="">Все субъекты</option>
          ${regionList.map(region =>
            `<option value="${escapeHtml(region)}" ${filter.region === region ? 'selected' : ''}>${escapeHtml(region)}</option>`).join('')}
        </select>
        <input type="date" id="salesFilterFrom" value="${filter.from}" title="Окно заявки / освобождение сцепки — с даты">
        <span class="muted">–</span>
        <input type="date" id="salesFilterTo" value="${filter.to}" title="Окно заявки / освобождение сцепки — по дату">
        <button class="button small" id="salesTask"
          title="Срез на дату: свободные и освобождающиеся сцепки, ремонты и пересменки, незакрытые регионы">📋 Задание</button>
        <button class="button ghost small" id="salesDeliveryPlan"
          title="График вывоза на месяц: жёлтые слоты без заявок — ваши задачи на прозвон">📅 План вывоза</button>
        <button class="button small" id="salesRadar"
          title="Куда продавать: горящие зоны со свободными машинами, рынок направлений и дыры плана — с бронированием ТС">🎯 Куда продавать</button>
        <button class="button ghost small" id="salesPresetToday" title="Только сегодняшний день">Сегодня</button>
        <button class="button ghost small" id="salesPresetWeek" title="Ближайшие 7 дней">7 дн</button>
        ${filterActive ? '<button class="button ghost small" id="salesFilterReset">✕ Сброс</button>' : ''}
        ${filterActive ? `<span class="filter-sum" title="Итог по отфильтрованному">заявок ${orders.length}/${allOrders.length}
          · ${money(orders.reduce((sumRate, order) => sumRate + Number(order.rate_vat || 0), 0))}
          · клиентов ${clients.length}</span>` : ''}
      </div>
    </div>
    <div class="salesboard">
      <div class="scol">
        <div class="scolh">Клиенты <span>${clients.length}</span>${hotTotal
          ? `<small class="muted" style="text-transform:none;font-weight:600">· 🔥 ${hotTotal} к подтверждению</small>` : ''}</div>
        <div class="list">${clientsList}</div>
        <div class="geohint">Клик по клиенту — все его заказы в хронологическом порядке. Заказ попадает
          сюда сразу после внесения и ждёт подтверждения; ближе 8 часов к погрузке неподтверждённый горит,
          продажам идёт сигнал в чат каждые 30 минут.</div>
      </div>
      <div class="scol">
        <div class="scolh">Потребность клиента <span>${orders.length}</span></div>
        <form id="salesForm">
          <label class="field">Заказчик
            <input name="customerName" list="salesCustomers" placeholder="выберите из справочника или введите нового"
              autocomplete="off" required>
            <datalist id="salesCustomers"></datalist>
          </label>
          <div class="form-grid">
            <label class="field">Пункт погрузки<input name="fromPoint" id="salesFromPoint" list="salesPlaces"
              placeholder="город / посёлок" autocomplete="off"></label>
            <label class="field">Пункт выгрузки<input name="toPoint" id="salesToPoint" list="salesPlaces"
              placeholder="город / посёлок" autocomplete="off"></label>
          </div>
          <datalist id="salesPlaces">${(data.reference.addresses || [])
            .map(item => `<option value="${escapeHtml(item.name)}">${escapeHtml(item.zone_name || '')}</option>`).join('')}
            ${data.reference.zones.flatMap(zone => [zone.name, ...(zone.aliases || [])]).sort()
            .map(place => `<option value="${escapeHtml(place)}"></option>`).join('')}</datalist>
          <div class="via-box">
            <div class="via-head">Промежуточные пункты <small class="muted">(погрузки и выгрузки по пути)</small></div>
            <div id="salesViaChips" class="via-chips"></div>
            <div class="via-add">
              <input id="salesViaPoint" list="salesPlaces" placeholder="пункт из справочника" autocomplete="off" style="flex:1">
              <select id="salesViaKind" title="Тип операции" style="width:110px">
                <option value="D">Выгрузка</option><option value="P">Погрузка</option>
              </select>
              <button type="button" class="button ghost small" id="salesViaAdd">+</button>
            </div>
          </div>
          <div id="salesPlannedKm" class="next-event" style="margin:0 0 6px"></div>
          <div class="form-grid">
            <label class="field">Геозона откуда<select name="fromZoneId" id="salesFrom">${zoneOptions}</select></label>
            <label class="field">Геозона куда<select name="toZoneId" id="salesTo">${zoneOptions}</select></label>
          </div>
          <div class="form-grid">
            <label class="field">Темп. режим<select name="temperatureMode">${temps}</select></label>
            <label class="field">Кузов<select name="bodyType">${bodies}</select></label>
          </div>
          <div class="form-grid">
            <label class="field">Окно с<input name="windowFrom" id="salesWinFrom" type="datetime-local" required
              value="${inputValue(atHour(state.month, WORK_START_HOUR))}"></label>
            <label class="field">Окно по<input name="windowTo" id="salesWinTo" type="datetime-local" required
              value="${inputValue(atHour(new Date(state.month.getTime() + 2 * 86_400_000), WORK_END_HOUR))}"></label>
          </div>
          <div class="form-grid">
            <label class="field">Ставка с НДС, ₽ (пусто = рыночная)<input name="rateVat" id="salesRate"
              type="text" inputmode="numeric" autocomplete="off"
              placeholder="можно вставить «95 000» или «95000,50»"></label>
            <label class="field">Без НДС, ₽ (авто)<input id="salesRateNet" readonly tabindex="-1"></label>
          </div>
          <label class="checkline"><input type="checkbox" name="cash"> Перевозка за наличные —
            водитель забирает оплату после выгрузки</label>
          <div class="comment-attach">
            <label class="field">Комментарий к рейсу<input name="comment" maxlength="500"
              placeholder="адрес, контакт, особенности погрузки" autocomplete="off"></label>
            <button type="button" class="button ghost small attach-btn" id="salesAttach"
              title="Прикрепить файлы к заявке: пропуск, схема проезда, заявка клиента (до 8 МБ) — загрузятся при бронировании">📎</button>
          </div>
          <div id="salesAttachChips" class="via-chips"></div>
          <input type="file" id="salesAttachInput" hidden multiple accept="${UPLOAD_ACCEPT}">
          <div id="salesFeas" class="feas"></div>
          <button class="button full">Забронировать</button>
        </form>
        <div class="scolh" style="margin-top:14px">Портфель · потребности клиента <span>${orders.length}</span>
          <button type="button" class="mine-toggle ${onlyMine ? 'on' : ''}" id="salesMyTasks"
            title="Показать только заявки, ожидающие вашего действия">мои: ${tasks.length}</button></div>
        <div class="list">${portfolio}</div>
        <div class="geohint">После назначения ТС заявка уходит к логисту в план (Гант) и в портфеле
          не показывается; вернётся как новая только при отклонении рейса.</div>
        <details class="rejected-details" ${state.salesRejectedOpen ? 'open' : ''} id="salesRejected">
          <summary>Отклонённые заявки <span class="scount">${rejectedOrders.length}</span></summary>
          <div class="list" style="margin-top:8px">${rejectedList}</div>
          <div class="geohint">Заявка попадает сюда, если ТС не назначено и указана причина отказа.
            «Вернуть в работу» переводит её обратно в портфель как новую.</div>
        </details>
      </div>
    </div>
  </div>`;

  // Разметка не изменилась — DOM не трогаем: без мигания, без прыжков
  // списков и прокрутки. Обработчики остались на прежних узлах.
  if (!renderInto(container, html)) {
    restoreScrolls(container, savedScrolls);
    return;
  }
  wireQuestionsStrip(container, context, questions);
  container.querySelector('[data-questions-toggle]')?.addEventListener('toggle', event => {
    state.salesQuestionsOpen = event.currentTarget.open;
  });
  restoreScrolls(container, savedScrolls);

  const rerender = () => renderSales(container, context);
  attachSearch(container.querySelector('#salesSearch'), value => {
    filter.q = value;
    rerender();
  });
  const dayIsoLocal = shift => new Date(Date.now() + shift * 86_400_000).toISOString().slice(0, 10);
  wireDemurrageChip(container, context);
  container.querySelector('#salesTask').onclick = () => salesTaskDialog(data, context);
  container.querySelector('#salesDeliveryPlan').onclick = () => deliveryPlanDialog(context);
  container.querySelector('#salesRadar').onclick = () => salesRadarDialog(context);
  container.querySelector('#salesPresetToday').onclick = () => {
    filter.from = dayIsoLocal(0); filter.to = dayIsoLocal(0);
    rerender();
  };
  container.querySelector('#salesPresetWeek').onclick = () => {
    filter.from = dayIsoLocal(0); filter.to = dayIsoLocal(7);
    rerender();
  };
  container.querySelector('#salesFilterRegion').onchange = event => {
    filter.region = event.currentTarget.value;
    rerender();
  };
  container.querySelector('#salesFilterZone').onchange = event => {
    filter.zone = event.currentTarget.value;
    rerender();
  };
  container.querySelector('#salesFilterFrom').onchange = event => {
    filter.from = event.currentTarget.value;
    rerender();
  };
  container.querySelector('#salesFilterTo').onchange = event => {
    filter.to = event.currentTarget.value;
    rerender();
  };
  container.querySelector('#salesFilterReset')?.addEventListener('click', () => {
    state.salesFilter = { zone: '', region: '', from: '', to: '', q: '' };
    rerender();
  });

  // Справочник заказчиков для выбора в форме: загружается один раз (кэш в state),
  // datalist сохраняет и свободный ввод — нового клиента можно вписать как раньше.
  const customersDatalist = container.querySelector('#salesCustomers');
  const fillCustomers = items => {
    customersDatalist.innerHTML = [...new Set(items.map(item => item.name))]
      .map(name => `<option value="${escapeHtml(name)}"></option>`).join('');
  };
  if (state.customersDirectory) fillCustomers(state.customersDirectory);
  else {
    api('/api/customers?q=').then(result => {
      state.customersDirectory = result.items;
      fillCustomers(result.items);
    }).catch(() => { /* нет права customers:read — останется свободный ввод */ });
  }
  // Ввод пункта автоматически определяет геозону по справочнику алиасов —
  // менеджер думает городами, зональная структура заполняется сама.
  const zoneByPlace = place => {
    const needle = String(place || '').trim().toLowerCase();
    if (!needle) return null;
    return data.reference.zones.find(zone => zone.name.toLowerCase() === needle ||
      (zone.aliases || []).some(alias => alias.toLowerCase() === needle)) || null;
  };
  const via = state.salesVia || (state.salesVia = []);
  // Скрепочка у комментария: файлы копятся в форме и заливаются после
  // создания заявки (id появляется только при бронировании).
  const attachInput = container.querySelector('#salesAttachInput');
  const redrawAttach = () => {
    const files = state.salesAttach || [];
    const chips = container.querySelector('#salesAttachChips');
    chips.innerHTML = files.map((file, index) => `<span class="via-chip">📎 ${escapeHtml(file.name.slice(0, 30))}
      <button type="button" data-attach-del="${index}">×</button></span>`).join('');
    chips.querySelectorAll('[data-attach-del]').forEach(button =>
      button.addEventListener('click', () => {
        state.salesAttach.splice(Number(button.dataset.attachDel), 1);
        redrawAttach();
      }));
    container.querySelector('#salesAttach').textContent = files.length ? `📎 ${files.length}` : '📎';
  };
  container.querySelector('#salesAttach').onclick = () => attachInput.click();
  attachInput.addEventListener('change', () => {
    for (const file of [...attachInput.files]) {
      if (file.size > 8 * 1_048_576) { toast(`«${file.name}» больше 8 МБ`, 'error'); continue; }
      (state.salesAttach || (state.salesAttach = [])).push(file);
    }
    attachInput.value = '';
    redrawAttach();
  });
  redrawAttach();
  const chainKm = (from, to, viaList) => {
    if (!from || !to) return null;
    const chain = [from, ...viaList.map(item => addressById(item.addressId)).filter(Boolean), to];
    let total = 0;
    for (let i = 1; i < chain.length; i += 1) {
      const leg = plannedKmBetween(chain[i - 1], chain[i]);
      if (leg == null) return null;
      total += leg;
    }
    return total;
  };
  const salesPlannedKm = () => {
    const from = addressByName(data, container.querySelector('#salesFromPoint').value);
    const to = addressByName(data, container.querySelector('#salesToPoint').value);
    const km = chainKm(from, to, via);
    const operations = 2 + via.length;
    container.querySelector('#salesPlannedKm').innerHTML = km
      ? `📏 Плановый километраж: <b>${km} км</b> · ${operations} операции ·
        транзит ~${Math.round(transitHours(km, data.settings.calculation, operations))} ч`
      : via.length ? `⛳ Промежуточных пунктов: ${via.length} — километраж появится при выборе адресов` : '';
  };
  const redrawVia = () => {
    container.querySelector('#salesViaChips').innerHTML = via.map((item, index) =>
      `<span class="via-chip">${item.kind === 'P' ? '⬆' : '⬇'} ${escapeHtml(item.point.slice(0, 30))}
        <button type="button" data-via-del="${index}" title="Убрать пункт">×</button></span>`).join('')
      || '<small class="muted">прямой рейс без заездов</small>';
    container.querySelectorAll('[data-via-del]').forEach(button =>
      button.addEventListener('click', () => { via.splice(Number(button.dataset.viaDel), 1); redrawVia(); }));
    salesPlannedKm();
  };
  container.querySelector('#salesViaAdd').addEventListener('click', () => {
    const input = container.querySelector('#salesViaPoint');
    const address = resolveAddress(data, input.value);
    const point = address ? address.name : input.value.trim();
    if (!point) return;
    if (!address) toast('Промежуточный пункт не из справочника — в километраж не войдёт', 'error');
    via.push({ point, kind: container.querySelector('#salesViaKind').value, addressId: address?.id || null });
    input.value = '';
    redrawVia();
  });
  redrawVia();
  [['salesFromPoint', 'salesFrom'], ['salesToPoint', 'salesTo']].forEach(([pointId, zoneId]) => {
    container.querySelector(`#${pointId}`).addEventListener('change', event => {
      // Пункт из справочника адресов надёжнее алиаса: частичный ввод
      // подтягивает полную карточку (имя, зона), затем плановый километраж.
      const address = resolveAddress(data, event.currentTarget.value);
      if (address) event.currentTarget.value = address.name;
      warnUnknownPlace(event.currentTarget, data);
      const zone = address
        ? data.reference.zones.find(item => item.id === address.zone_id)
        : zoneByPlace(event.currentTarget.value);
      if (zone) {
        container.querySelector(`#${zoneId}`).value = zone.id;
        feasibility();
      }
      salesPlannedKm();
    });
  });

  // Выбор известного клиента подставляет его основное направление и рыночную ставку.
  wireNetField(container.querySelector('#salesForm'),
    container.querySelector('#salesRateNet'), data);
  container.querySelector('[name="customerName"]').addEventListener('change', event => {
    const name = event.currentTarget.value.trim();
    const entries = (state.customersDirectory || []).filter(item => item.name === name);
    if (!entries.length) return;
    const main = entries.sort((a, b) => b.trip_count - a.trip_count)[0];
    if (main.from_zone_id) container.querySelector('#salesFrom').value = main.from_zone_id;
    if (main.to_zone_id) container.querySelector('#salesTo').value = main.to_zone_id;
    feasibility();
    // Средняя ставка клиента — точнее рыночной по направлению, ставим после пересчёта.
    const rate = container.querySelector('#salesRate');
    if (!rate.value && main.average_rate_vat) {
      rate.placeholder = Math.round(main.average_rate_vat).toLocaleString('ru-RU');
    }
  });

  const feasibility = () => {
    const fromId = container.querySelector('#salesFrom').value;
    const toId = container.querySelector('#salesTo').value;
    const windowFrom = container.querySelector('#salesWinFrom').value;
    const info = routeInfo(data, fromId, toId);
    const rateInput = container.querySelector('#salesRate');
    if (!rateInput.value) rateInput.placeholder = info.rate.toLocaleString('ru-RU');
    const fromName = data.reference.zones.find(zone => zone.id === fromId)?.name;
    // Значение datetime-local не содержит зоны — трактуем как UTC, как и остальные метки времени.
    const startsAt = windowFrom ? `${windowFrom}:00.000Z` : null;
    const candidates = startsAt ? matchVehicles(data, fromName, startsAt) : [];
    // Ёмкость честная: забронированные логистом машины не предлагаются
    // как «свободная сцепка» — под них уже есть план.
    const heldIds = new Set((data.vehicleHolds || []).map(hold => hold.vehicle_id));
    const freeCandidates = candidates.filter(candidate => !heldIds.has(candidate.vehicle.id));
    const heldCount = candidates.length - freeCandidates.length;
    const best = freeCandidates[0];
    const arrival = startsAt
      ? new Date(Date.parse(startsAt) + info.transit * 86_400_000).toISOString() : null;
    const hours = Math.round(info.transit * 24);
    // Рынок плеча по фактическим рейсам за 60 дней — точнее прейскуранта:
    // введённая ставка сразу сравнивается с медианой (лечит дешёвые обратки).
    const fromZoneName = data.reference.zones.find(zone => zone.id === fromId)?.name;
    const toZoneName = data.reference.zones.find(zone => zone.id === toId)?.name;
    const marketDir = directionMarket(data).find(dir =>
      dir.from === fromZoneName && dir.to === toZoneName);
    const entered = parseMoney(rateInput.value) || 0;
    const marketLine = marketDir
      ? `<div class="feas-row ${entered && entered < marketDir.p25 ? 'bad' : ''}"><span>Рынок плеча (60 дн)</span>
          <b>${money(marketDir.median)} <small class="muted">(${money(marketDir.p25)}–${money(marketDir.p75)})</small>${entered
    ? ` · ваша ${entered < marketDir.median ? '−' : '+'}${Math.abs(Math.round((entered / marketDir.median - 1) * 100))}%` : ''}</b></div>`
      : '';
    container.querySelector('#salesFeas').innerHTML = `
      <div class="feas-t">Осуществимость</div>
      <div class="feas-row"><span>Рыночная ставка</span><b>${money(info.rate)}</b></div>
      ${marketLine}
      <div class="feas-row"><span>Срок доставки</span><b>${hours} ч · ${info.distance.toLocaleString('ru-RU')} км</b></div>
      ${arrival ? `<div class="feas-row"><span>Прибытие ~</span><b>${fmtDateTime(arrival)}</b></div>` : ''}
      <div class="feas-row ${best ? 'ok' : 'bad'}"><span>Свободная сцепка</span>
        <b>${best
          ? `${escapeHtml(best.vehicle.plate)} · ${best.inZone ? 'в зоне' : escapeHtml(best.zoneName || 'перегон')}`
          : heldCount ? `все под бронью (🔒 ${heldCount}) — согласуйте с логистом` : 'нет свободной к сроку'}</b></div>
      ${best && heldCount ? `<div class="feas-row"><span>Ёмкость к сроку</span>
        <b>${freeCandidates.length} без брони · 🔒 ${heldCount}</b></div>` : ''}
      ${best && !best.ready
        ? `<div class="feas-row bad"><span>Готова к подаче</span><b>${fmtDateTime(best.readyAt)}</b></div>` : ''}`;
  };
  ['salesFrom', 'salesTo', 'salesWinFrom'].forEach(id =>
    container.querySelector(`#${id}`).addEventListener('change', feasibility));
  container.querySelector('#salesRate').addEventListener('input', feasibility);
  feasibility();

  // Карточка клиента: раскрыть/свернуть его заказы.
  container.querySelectorAll('[data-client]').forEach(element =>
    element.addEventListener('click', () => {
      const name = element.dataset.client;
      state.salesClientOpen = state.salesClientOpen === name ? null : name;
      rerender();
    }));
  container.querySelectorAll('[data-client-card]').forEach(button =>
    button.addEventListener('click', event => {
      event.stopPropagation();
      customerCardDialog(button.dataset.clientCard, context);
    }));
  container.querySelectorAll('[data-kpi-client]').forEach(row =>
    row.addEventListener('click', () => {
      state.salesClientOpen = row.dataset.kpiClient;
      state.salesKpiOpen = null;
      rerender();
      container.querySelector(`[data-client="${CSS.escape(row.dataset.kpiClient)}"]`)
        ?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }));

  // Плашки-KPI: клик раскрывает список категории; выбор заявки открывает
  // редактирование, выбор сцепки — заполняет форму бронирования.
  container.querySelectorAll('[data-kpi]').forEach(badge =>
    badge.addEventListener('click', event => {
      if (event.target.closest('.skpi-drop')) return;
      const key = badge.dataset.kpi;
      state.salesKpiOpen = state.salesKpiOpen === key ? null : key;
      rerender();
    }));
  container.querySelectorAll('[data-kpi-order]').forEach(row =>
    row.addEventListener('click', () => {
      const order = data.orders.find(item => item.id === row.dataset.kpiOrder);
      state.salesKpiOpen = null;
      rerender();
      if (order) editOrderDialog(order, data, context);
    }));
  // Бронирование потребности клиента: форма → POST /api/orders (+ файлы),
  // защита от дублей по заказчику/направлению/окну. (Обработчик был утерян
  // при переработке левой колонки 21.08 — форма уходила нативным submit,
  // страницу перезагружало в Гант, заявка не создавалась.)
  container.querySelector('#salesForm').onsubmit = async event => {
    event.preventDefault();
    const values = formValues(event.currentTarget);
    values.cash = values.cash ? 1 : 0;
    values.fromAddressId = addressByName(data, values.fromPoint)?.id || null;
    values.toAddressId = addressByName(data, values.toPoint)?.id || null;
    values.via = via;
    values.rateVat = parseMoney(values.rateVat) || '';
    if (!values.rateVat) {
      values.rateVat = routeInfo(data, values.fromZoneId, values.toZoneId).rate;
    }
    // Нехватка машин в зоне погрузки — НЕ повод терять заявку. Раньше здесь
    // стоял confirm, и отказ молча прерывал сохранение: для менеджера это
    // выглядело как «заявка исчезла после сохранения» (кейс Форуминторг
    // Мытищи → Кузнецк 28.08, в зоне Москва не было ни одной свободной
    // машины). Теперь заявка создаётся всегда, а нехватка ёмкости уходит
    // предупреждением менеджеру и сигналом логисту — он спланирует перегон.
    const fromZoneNameWarn = data.reference.zones.find(zone => zone.id === values.fromZoneId)?.name;
    const zoneCapacity = freeVehiclesByZone(data).find(group => group.zone === fromZoneNameWarn);
    const noCapacity = !zoneCapacity || zoneCapacity.freeNoHold === 0;
    // Защита от дублей: похожая заявка уже в портфеле (тот же заказчик,
    // направление и пересекающееся окно) — вероятно, её просто не нашли в списке.
    const duplicate = allOrders.find(order =>
      order.customer_name.trim().toLowerCase() === String(values.customerName).trim().toLowerCase() &&
      order.from_zone_id === values.fromZoneId && order.to_zone_id === values.toZoneId &&
      Date.parse(order.window_from) < Date.parse(values.windowTo) &&
      Date.parse(values.windowFrom) < Date.parse(order.window_to));
    if (duplicate && !confirm(`Похожая заявка «${duplicate.customer_name}» с пересекающимся окном уже в портфеле (наверху списка). Создать ещё одну?`)) {
      // Явный отклик: иначе отказ выглядит как «сохранил, а заявки нет».
      toast('Заявка НЕ создана — вы отказались от дубля. Данные остались в форме', 'error');
      return;
    }
    try {
      const created = await api('/api/orders', { method: 'POST', body: JSON.stringify(values) });
      let uploaded = 0;
      for (const file of state.salesAttach || []) {
        try { await uploadOrderFile(created.id, file); uploaded += 1; }
        catch (error) { toast(`Файл «${file.name}»: ${error.message}`, 'error'); }
      }
      state.salesAttach = [];
      toast(`Забронировано — заявка № ${created.orderNo}${uploaded ? ` · 📎 файлов: ${uploaded}` : ''} в портфеле и в карточке клиента`);
      // Ёмкости в зоне нет — говорим об этом ПОСЛЕ создания и сообщаем логисту.
      if (noCapacity) {
        toast(`⚠ В зоне «${fromZoneNameWarn || '—'}» свободных машин сейчас нет — логист уведомлён, ` +
          'нужен перегон или освобождение сцепки', 'error');
        api('/api/notify-capacity', { method: 'POST', body: JSON.stringify({
          orderId: created.id, zone: fromZoneNameWarn || ''
        }) }).catch(() => { /* уведомление не критично для создания заявки */ });
      }
      state.salesVia = [];
      const zoneName = id => data.reference.zones.find(zone => zone.id === id)?.name || '';
      dropFilterIfHides(state, {
        customer_name: values.customerName,
        from_name: zoneName(values.fromZoneId), to_name: zoneName(values.toZoneId),
        from_point: values.fromPoint, to_point: values.toPoint,
        from_address_id: values.fromAddressId, to_address_id: values.toAddressId,
        window_from: values.windowFrom, window_to: values.windowTo
      }, created.orderNo);
      await context.onReload();
    } catch (error) { toast(error.message, 'error'); }
  };

  container.querySelector('#salesMyTasks').onclick = () => {
    state.salesOnlyMine = !state.salesOnlyMine;
    rerender();
  };
  container.querySelector('#salesRejected').addEventListener('toggle', event => {
    state.salesRejectedOpen = event.currentTarget.open;
  });

  container.querySelectorAll('[data-act]').forEach(button =>
    button.addEventListener('click', async event => {
      event.stopPropagation();
      // Ищем по всем заявкам: кнопки живут не только в портфеле (стадии 0–1),
      // но и в заказах карточки клиента (стадии 0–3) — поиск по портфелю
      // делал их «некликабельными» для назначенных и идущих заказов.
      const order = data.orders.find(item => item.id === button.dataset.order);
      if (!order) return;
      const kind = button.dataset.act;
      if (kind === 'assign') return context.openAssign(order);
      if (kind === 'reject') return rejectDialog(order, data, context);
      button.disabled = true;
      try {
        if (kind === 'confirm') {
          await api(`/api/orders/${order.id}`, {
            method: 'PATCH', body: JSON.stringify({ stage: 1 })
          });
          toast('Подтверждено — задача передана логисту');
        } else if (kind === 'trip-status') {
          if (!order.trip_id) throw new Error('У заявки нет рейса');
          await api(`/api/trips/${order.trip_id}`, {
            method: 'PATCH', body: JSON.stringify({ status: button.dataset.status })
          });
          const next = { run: 'Рейс в пути', unloaded: 'Выгрузка отмечена', paid: 'Оплата отмечена' };
          toast(next[button.dataset.status] || 'Статус обновлён');
        }
        await context.onReload();
      } catch (error) {
        button.disabled = false;
        toast(error.message, 'error');
      }
    }));

  container.querySelectorAll('[data-restore]').forEach(button =>
    button.addEventListener('click', async event => {
      event.stopPropagation();
      try {
        await api(`/api/orders/${button.dataset.restore}`, {
          method: 'PATCH', body: JSON.stringify({ status: 'new', stage: 0 })
        });
        toast('Заявка возвращена в работу');
        await context.onReload();
      } catch (error) { toast(error.message, 'error'); }
    }));

  // Копия заявки: те же данные, но всегда НОВЫЙ id и № (их выдаёт сервер);
  // стадия 0, без ТС и рейса. Сразу открывается на правку — обычно копию
  // делают под повторный рейс на другую дату.
  container.querySelectorAll('[data-copy-order]').forEach(button =>
    button.addEventListener('click', async event => {
      event.stopPropagation();
      // По всем заявкам — копию делают и из карточки клиента (стадии 0–3).
      const order = data.orders.find(item => item.id === button.dataset.copyOrder);
      if (!order) return;
      button.disabled = true;
      try {
        const created = await api('/api/orders', { method: 'POST', body: JSON.stringify({
          customerName: order.customer_name,
          fromZoneId: order.from_zone_id, toZoneId: order.to_zone_id,
          fromPoint: order.from_point || '', toPoint: order.to_point || '',
          rateVat: order.rate_vat, windowFrom: order.window_from, windowTo: order.window_to,
          temperatureMode: order.temperature_mode || '', bodyType: order.body_type || '',
          comment: order.comment || '', cash: Number(order.cash) ? 1 : 0,
          fromAddressId: order.from_address_id || null, toAddressId: order.to_address_id || null,
          via: (() => { try { return JSON.parse(order.via_json || '[]'); } catch { return []; } })()
        }) });
        toast(`Копия создана — заявка № ${created.orderNo}, новый ID. Проверьте окно погрузки.`);
        // Копия наследует поля исходной заявки, но № и статус — свои:
        // при поиске по номеру исходной копия иначе «пропадёт» из списка.
        dropFilterIfHides(state, { ...order, order_no: created.orderNo, rejection_reason: '' }, created.orderNo);
        await context.onReload();
        const copy = (context.state.data.orders || []).find(item => item.id === created.id);
        if (copy) editOrderDialog(copy, context.state.data, context);
      } catch (error) { button.disabled = false; toast(error.message, 'error'); }
    }));

  container.querySelectorAll('[data-edit-order]').forEach(button =>
    button.addEventListener('click', event => {
      event.stopPropagation();
      const order = data.orders.find(item => item.id === button.dataset.editOrder);
      if (order) editOrderDialog(order, data, context);
    }));

  container.querySelectorAll('[data-delete-order]').forEach(button =>
    button.addEventListener('click', async event => {
      event.stopPropagation();
      if (!confirm('Убрать заявку из оперативного реестра? Для аналитики она останется в отчёте.')) return;
      try {
        await api(`/api/orders/${button.dataset.deleteOrder}`, { method: 'DELETE' });
        toast('Заявка удалена — доступна в отчёте «Реестр заявок»');
        await context.onReload();
      } catch (error) { toast(error.message, 'error'); }
    }));
}

// Редактирование потребности: те же поля, что и при бронировании.
// Вызывается из портфеля продаж, из выпадающих списков плашек-KPI
// и из блока логиста (карточка рейса в Ганте). Для назначенной заявки
// новая ставка синхронизируется с рейсом на сервере.
export function editOrderDialog(order, data, context) {
  const zoneOptions = selected => data.reference.zones.map(zone =>
    `<option value="${zone.id}" ${zone.id === selected ? 'selected' : ''}>${escapeHtml(zone.name)}</option>`).join('');
  const orderOptions = data.settings.orderOptions || {};
  const options = (items, current) => (items || []).map(item =>
    `<option ${item === current ? 'selected' : ''}>${escapeHtml(item)}</option>`).join('');
  // Диалог вызывается и из продаж, и из блока логиста (Гант) — datalist
  // пунктов встроен в модалку, чтобы не зависеть от разметки доски продаж.
  const trip = order.trip_id ? data.trips.find(item => item.id === order.trip_id) : null;
  context.showModal(`<form id="editOrderForm">
    <h2>Изменить потребность${order.order_no ? ` · № ${escapeHtml(order.order_no)}` : ''}</h2>
    <p class="muted">${escapeHtml(routeLabel(order))} · создана ${fmtDateTime(order.created_at)}
      · номер присвоен системой</p>
    ${trip ? `<p class="muted">В плане у логиста: <span class="mono">${escapeHtml(trip.vehicle_plate || '')}</span>
      · рейс ${fmtDateTime(trip.starts_at)} → ${fmtDateTime(trip.ends_at)} — новая ставка обновит и рейс</p>` : ''}
    <label class="field">Заказчик
      <input name="customerName" list="salesCustomers" value="${escapeHtml(order.customer_name)}" required autocomplete="off">
    </label>
    <div class="form-grid">
      <label class="field">Пункт погрузки<input name="fromPoint" id="editFromPoint" list="editPlaces"
        value="${escapeHtml(order.from_point || '')}" autocomplete="off"></label>
      <label class="field">Пункт выгрузки<input name="toPoint" id="editToPoint" list="editPlaces"
        value="${escapeHtml(order.to_point || '')}" autocomplete="off"></label>
    </div>
    <datalist id="editPlaces">${(data.reference.addresses || [])
      .map(item => `<option value="${escapeHtml(item.name)}">${escapeHtml(item.zone_name || '')}</option>`).join('')}
      ${data.reference.zones.flatMap(zone => [zone.name, ...(zone.aliases || [])]).sort()
      .map(place => `<option value="${escapeHtml(place)}"></option>`).join('')}</datalist>
    <div class="via-box">
      <div class="via-head">Промежуточные пункты</div>
      <div id="editViaChips" class="via-chips"></div>
      <div class="via-add">
        <input id="editViaPoint" list="editPlaces" placeholder="пункт из справочника" autocomplete="off" style="flex:1">
        <select id="editViaKind" style="width:110px">
          <option value="D">Выгрузка</option><option value="P">Погрузка</option>
        </select>
        <button type="button" class="button ghost small" id="editViaAdd">+</button>
      </div>
    </div>
    <div id="editPlannedKm" class="next-event" style="margin:0 0 6px">${order.planned_km
      ? `📏 Плановый километраж: <b>${Math.round(order.planned_km)} км</b> (по справочнику адресов)` : ''}</div>
    <div class="form-grid">
      <label class="field">Геозона откуда<select name="fromZoneId" id="editFromZone">${zoneOptions(order.from_zone_id)}</select></label>
      <label class="field">Геозона куда<select name="toZoneId" id="editToZone">${zoneOptions(order.to_zone_id)}</select></label>
    </div>
    <div class="form-grid">
      <label class="field">Темп. режим<select name="temperatureMode">${options(orderOptions.temperatureModes, order.temperature_mode)}</select></label>
      <label class="field">Кузов<select name="bodyType">${options(orderOptions.bodyTypes, order.body_type)}</select></label>
    </div>
    <div class="form-grid">
      <label class="field">Окно с<input name="windowFrom" type="datetime-local" required value="${inputValue(order.window_from)}"></label>
      <label class="field">Окно по<input name="windowTo" type="datetime-local" required value="${inputValue(order.window_to)}"></label>
    </div>
    <div class="form-grid">
      <label class="field">Ставка с НДС, ₽<input name="rateVat" type="text" inputmode="numeric"
        autocomplete="off" value="${Number(order.rate_vat) || 0}"></label>
      <label class="field">Без НДС, ₽ (авто)<input id="editRateNet" readonly tabindex="-1"></label>
    </div>
    <label class="checkline"><input type="checkbox" name="cash" ${Number(order.cash) ? 'checked' : ''}>
      Перевозка за наличные — водитель забирает оплату после выгрузки</label>
    <label class="field">Комментарий к рейсу<input name="comment" maxlength="500"
      value="${escapeHtml(order.comment || '')}" placeholder="адрес, контакт, особенности погрузки"></label>
    <div class="field"><span>📎 Файлы к заявке <small class="muted">(пропуск, схема проезда,
        заявка клиента · до 8 МБ)</small></span>
      <div class="ofile-list" id="orderFilesBox"></div>
      <label class="button ghost small ofile-add">📎 Прикрепить файл
        <input type="file" id="orderFileInput" hidden accept="${UPLOAD_ACCEPT}"></label>
    </div>
    <div class="modal-actions">
      ${trip && context.openTrip ? `<button type="button" class="button ghost" id="editOrderTrip"
        title="Открыть карточку рейса: времена подачи, статус, удаление">Рейс</button>` : ''}
      <button type="button" class="button ghost" data-close>Отмена</button>
      <button class="button" type="submit">Сохранить</button>
    </div>
  </form>`);
  // Файлы заявки: загрузка сразу на сервер, список обновляется локально —
  // карточки подхватят перемены при следующей перерисовке доски.
  const filesBox = document.getElementById('orderFilesBox');
  const redrawFiles = () => {
    filesBox.innerHTML = orderFilesOf(data, order.id).map(file => `<div class="ofile-row">
      <a class="ofile" href="/api/order-files/${file.id}" target="_blank" rel="noopener">📎 ${escapeHtml(file.file_name)}</a>
      <small class="muted">${fileSizeLabel(file.size)} · ${escapeHtml(file.uploaded_by || '')}</small>
      <button type="button" class="button ghost small" data-ofile-del="${file.id}" title="Удалить файл">✕</button>
    </div>`).join('') || '<small class="muted">файлов нет</small>';
    filesBox.querySelectorAll('[data-ofile-del]').forEach(button =>
      button.addEventListener('click', async () => {
        if (!confirm('Удалить файл у заявки?')) return;
        try {
          await api(`/api/order-files/${button.dataset.ofileDel}`, { method: 'DELETE' });
          data.orderFiles = (data.orderFiles || []).filter(file => file.id !== button.dataset.ofileDel);
          redrawFiles();
        } catch (error) { toast(error.message, 'error'); }
      }));
  };
  redrawFiles();
  document.getElementById('orderFileInput').addEventListener('change', async event => {
    const file = event.currentTarget.files[0];
    event.currentTarget.value = '';
    if (!file) return;
    try {
      const payload = { file: await uploadOrderFile(order.id, file) };
      (data.orderFiles ||= []).push(payload.file);
      redrawFiles();
      toast('Файл прикреплён');
    } catch (error) { toast(error.message, 'error'); }
  });
  if (trip && context.openTrip) {
    document.getElementById('editOrderTrip').onclick = () => {
      context.closeModal();
      context.openTrip(trip);
    };
  }
  // Пункт определяет геозону по алиасам — как в форме бронирования.
  const zoneByPlace = place => {
    const needle = String(place || '').trim().toLowerCase();
    if (!needle) return null;
    return data.reference.zones.find(zone => zone.name.toLowerCase() === needle ||
      (zone.aliases || []).some(alias => alias.toLowerCase() === needle)) || null;
  };
  const editVia = (() => { try { return JSON.parse(order.via_json || '[]'); } catch { return []; } })();
  const editAddressById = id => id ? (data.reference.addresses || []).find(item => item.id === id) : null;
  const editPlannedKm = () => {
    const from = addressByName(data, document.getElementById('editFromPoint').value);
    const to = addressByName(data, document.getElementById('editToPoint').value);
    const chain = from && to
      ? [from, ...editVia.map(item => editAddressById(item.addressId)).filter(Boolean), to] : null;
    let km = null;
    if (chain) {
      km = 0;
      for (let i = 1; i < chain.length; i += 1) {
        const leg = plannedKmBetween(chain[i - 1], chain[i]);
        if (leg == null) { km = null; break; }
        km += leg;
      }
    }
    if (km) document.getElementById('editPlannedKm').innerHTML =
      `📏 Плановый километраж: <b>${km} км</b> · ${2 + editVia.length} операции ·
        транзит ~${Math.round(transitHours(km, data.settings.calculation, 2 + editVia.length))} ч`;
  };
  const redrawEditVia = () => {
    document.getElementById('editViaChips').innerHTML = editVia.map((item, index) =>
      `<span class="via-chip">${item.kind === 'P' ? '⬆' : '⬇'} ${escapeHtml(item.point.slice(0, 30))}
        <button type="button" data-evia-del="${index}">×</button></span>`).join('')
      || '<small class="muted">прямой рейс без заездов</small>';
    document.querySelectorAll('[data-evia-del]').forEach(button =>
      button.addEventListener('click', () => { editVia.splice(Number(button.dataset.eviaDel), 1); redrawEditVia(); }));
    editPlannedKm();
  };
  document.getElementById('editViaAdd').onclick = () => {
    const input = document.getElementById('editViaPoint');
    const address = resolveAddress(data, input.value);
    const point = address ? address.name : input.value.trim();
    if (!point) return;
    if (!address) toast('Промежуточный пункт не из справочника — в километраж не войдёт', 'error');
    editVia.push({ point, kind: document.getElementById('editViaKind').value, addressId: address?.id || null });
    input.value = '';
    redrawEditVia();
  };
  redrawEditVia();
  [['editFromPoint', 'editFromZone'], ['editToPoint', 'editToZone']].forEach(([pointId, zoneId]) => {
    // Кривой пункт подсвечивается сразу при открытии правки (кейс 892).
    warnUnknownPlace(document.getElementById(pointId), data);
    document.getElementById(pointId).addEventListener('change', event => {
      const address = resolveAddress(data, event.currentTarget.value);
      if (address) event.currentTarget.value = address.name;
      warnUnknownPlace(event.currentTarget, data);
      const zone = address
        ? data.reference.zones.find(item => item.id === address.zone_id)
        : zoneByPlace(event.currentTarget.value);
      if (zone) document.getElementById(zoneId).value = zone.id;
      editPlannedKm();
    });
  });
  wireNetField(document.getElementById('editOrderForm'),
    document.getElementById('editRateNet'), data);
  document.getElementById('editOrderForm').onsubmit = async event => {
    event.preventDefault();
    const values = formValues(event.target);
    values.rateVat = parseMoney(values.rateVat);
    values.cash = values.cash ? 1 : 0;
    values.fromAddressId = addressByName(data, values.fromPoint)?.id || null;
    values.toAddressId = addressByName(data, values.toPoint)?.id || null;
    values.via = editVia;
    try {
      await api(`/api/orders/${order.id}`, {
        method: 'PATCH', body: JSON.stringify(values)
      });
      context.closeModal();
      toast('Потребность обновлена');
      // Правка могла вывести заявку из активного фильтра (сменили зону,
      // пункт или окно) — карточка не должна «пропасть» после сохранения.
      const zoneName = id => data.reference.zones.find(zone => zone.id === id)?.name || '';
      dropFilterIfHides(context.state, {
        customer_name: values.customerName,
        from_name: zoneName(values.fromZoneId), to_name: zoneName(values.toZoneId),
        from_point: values.fromPoint, to_point: values.toPoint,
        from_address_id: values.fromAddressId, to_address_id: values.toAddressId,
        window_from: values.windowFrom, window_to: values.windowTo,
        order_no: order.order_no
      }, order.order_no);
      await context.onReload();
    } catch (error) { toast(error.message, 'error'); }
  };
}

// Отклонение заявки: причина обязательна — она попадёт в реестр и отчёт.
// Используется и продажами (портфель), и логистом (очередь назначения).
export { rejectDialog as rejectOrderDialog };
function rejectDialog(order, data, context) {
  const reasons = data.settings.rejectionReasons || [];
  context.showModal(`<form id="rejectOrderForm">
    <h2>Отклонить заявку</h2>
    <p class="muted">${escapeHtml(order.customer_name)} · ${escapeHtml(routeLabel(order))}
      · ${money(order.rate_vat)}</p>
    <label class="field">Причина отказа
      <select name="rejectionReason" required>
        <option value="">— выберите причину —</option>
        ${reasons.map(reason => `<option>${escapeHtml(reason)}</option>`).join('')}
      </select>
    </label>
    <div class="modal-actions">
      <button type="button" class="button ghost" data-close>Отмена</button>
      <button class="button danger">Отклонить</button>
    </div>
  </form>`);
  document.getElementById('rejectOrderForm').onsubmit = async event => {
    event.preventDefault();
    const reason = new FormData(event.currentTarget).get('rejectionReason');
    if (!reason) { toast('Выберите причину отказа', 'error'); return; }
    try {
      await api(`/api/orders/${order.id}`, {
        method: 'PATCH', body: JSON.stringify({ status: 'cancelled', rejectionReason: reason })
      });
      context.closeModal();
      toast('Заявка отклонена');
      await context.onReload();
    } catch (error) { toast(error.message, 'error'); }
  };
}

// Модалка назначения ТС (маркетплейс-стиль из ТК 21).
// options.autoConfirm — назначение из вкладки «Логист»: подтверждение
// логистом проходит автоматически, рейс сразу уходит диспетчеру.
// Из продаж — без опции: назначение обязан подтвердить логист.
export function assignDialog(order, data, showModal, closeModal, onReload, options = {}) {
  const orderFromAddress = order.from_address_id
    ? (data.reference.addresses || []).find(item => item.id === order.from_address_id)
    : resolveAddress(data, order.from_point || order.from_name);
  const candidates = matchVehicles(data, order.from_name, order.window_from, orderFromAddress);
  const workFleet = data.vehicles.filter(vehicle => vehicle.status === 'work');
  const loadMs = Date.parse(order.window_from);
  showModal(`<h2>Назначить ТС · ${escapeHtml(routeLabel(order))}</h2>
    <p class="muted">${escapeHtml(order.customer_name)} · окно ${fmtDateTime(order.window_from)} → ${fmtDateTime(order.window_to)} · ${escapeHtml(order.body_type || 'Реф')} ${escapeHtml(order.temperature_mode || '')}</p>
    ${order.comment ? `<p class="muted">💬 ${escapeHtml(order.comment)}</p>` : ''}
    <div class="list" style="max-height:220px;overflow:auto;margin-bottom:10px">
      ${candidates.slice(0, 8).map(candidate => `<button type="button" class="list-item sugtruck" data-plate="${candidate.vehicle.id}">
        <span style="flex:1;min-width:0"><strong class="mono">${escapeHtml(candidate.vehicle.plate)}</strong>
        ${(data.vehicleHolds || []).some(hold => hold.vehicle_id === candidate.vehicle.id)
    ? `<span class="badge warn" title="${escapeHtml((data.vehicleHolds || []).filter(hold => hold.vehicle_id === candidate.vehicle.id).map(hold => `Бронь: ${hold.held_by_name}${hold.note ? ` — ${hold.note}` : ''} до окончания`).join(''))}">🔒 бронь</span>` : ''}
        <small class="muted"> · ${escapeHtml(candidate.vehicle.type_name)}${candidate.emptyKm != null
          ? ` · подгон ~${candidate.emptyKm} км${candidate.approx ? ' (по городу/зоне)' : ''}` : ''}${candidate.readyAt
          ? ` · ${candidate.ready ? 'готова с' : '⚠ готова только с'} ${fmtDateTime(candidate.readyAt)}` : ''}</small>
        ${candidate.stillRunning ? `<small class="next-event warn">🛣 сейчас в рейсе → ${escapeHtml(candidate.lastTrip.to_point || candidate.lastTrip.to_name || '')}
          · план выгрузки ${fmtDateTime(tripBusyUntilMs(candidate.lastTrip))} — освобождение расчётное</small>` : ''}
        ${nextEventHint(nextVehicleEvent(data, candidate.vehicle.id, loadMs), loadMs)}</span>
        <span class="badge ${candidate.inZone ? 'ok' : 'warn'}" style="margin-left:auto"
          title="${candidate.inZone ? 'Позиция в геозоне погрузки' : `Позиция: ${escapeHtml(candidate.region || candidate.zoneName || '—')}`}">${candidate.inZone ? 'в зоне' : escapeHtml(candidate.region || candidate.zoneName || 'перегон')}</span>
      </button>`).join('') || '<p class="muted">Нет свободных к сроку — выберите вручную.</p>'}
    </div>
    ${(() => {
    // «Как в прошлый раз»: 84% заявок — повторяющиеся маршруты. Машины,
    // возившие этого клиента по этому направлению за 30 дней, — в один клик.
    const monthAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const usual = new Map();
    for (const trip of data.trips) {
      if (trip.status === 'rejected' || trip.starts_at < monthAgo) continue;
      if (trip.customer_name !== order.customer_name ||
          trip.from_zone_id !== order.from_zone_id || trip.to_zone_id !== order.to_zone_id) continue;
      if (!usual.has(trip.vehicle_id)) usual.set(trip.vehicle_id, { count: 0, plate: trip.vehicle_plate });
      usual.get(trip.vehicle_id).count += 1;
    }
    const top = [...usual.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 5)
      .filter(([id]) => workFleet.some(vehicle => vehicle.id === id));
    return top.length ? `<div class="via-box" style="margin-bottom:8px">
        <div class="via-head">🔁 По этому маршруту обычно ходят <small class="muted">(клиент + направление, 30 дней)</small></div>
        <div class="via-chips">${top.map(([id, info]) =>
    `<button type="button" class="button ghost small" data-usual="${id}"
          title="Рейсов за 30 дней: ${info.count} — выбрать эту машину">${escapeHtml(info.plate)} · ${info.count}</button>`).join('')}
        </div></div>` : '';
  })()}
    <label class="field">Или вручную из парка
      <input id="assignVehicleSearch" placeholder="🔍 поиск: номер, водитель, тип" autocomplete="off">
      <select id="assignVehicle" style="margin-top:4px">
      ${workFleet.map(vehicle => `<option value="${vehicle.id}">${escapeHtml(vehicle.plate)} · ${escapeHtml(vehicle.type_name)} · ${escapeHtml(vehicle.driver_name || 'без водителя')}</option>`).join('')}
    </select></label>
    <div id="assignNext"></div>
    <div class="modal-actions">
      <button type="button" class="button ghost" data-close>Отмена</button>
      <button type="button" class="button" id="assignOk">Назначить</button>
    </div>`);
  const select = document.getElementById('assignVehicle');
  wireSelectSearch(document.getElementById('assignVehicleSearch'), select);
  const showNext = () => {
    // Пустой выбор (поиск ничего не нашёл) — без подсказки: иначе она
    // обещала бы «сцепка свободна» про несуществующее ТС.
    document.getElementById('assignNext').innerHTML = select.value
      ? nextEventHint(nextVehicleEvent(data, select.value, loadMs), loadMs) : '';
  };
  select.addEventListener('change', showNext);
  if (candidates[0]) select.value = candidates[0].vehicle.id;
  showNext();
  document.querySelectorAll('.sugtruck').forEach(element =>
    element.addEventListener('click', () => { select.value = element.dataset.plate; showNext(); }));
  document.querySelectorAll('[data-usual]').forEach(button =>
    button.addEventListener('click', () => { select.value = button.dataset.usual; showNext(); }));
  document.getElementById('assignOk').onclick = async () => {
    try {
      await api(`/api/orders/${order.id}/assign`, {
        method: 'POST',
        body: JSON.stringify({ vehicleId: select.value, autoConfirm: Boolean(options.autoConfirm) })
      });
      closeModal();
      toast(options.autoConfirm
        ? 'ТС назначена и подтверждена — рейс у диспетчера'
        : 'ТС назначена — рейс проведён в план');
      await onReload();
    } catch (error) { toast(error.message, 'error'); }
  };
}
