// «📥 Заявки из письма» — универсальный распознаватель: клиенты присылают
// заказы и таблицами из Excel, и прописным текстом. Менеджер вставляет текст
// письма как есть, система разбирает строки в черновики заявок, показывает
// предпросмотр с правками на месте — и создаёт пакет одним нажатием.
// Геозоны не спрашиваются: сервер определяет их по пунктам сам.
import { api, escapeHtml, formatDateTime, parseMoney, toast } from './api.js';
import { cityAddress, resolveAddress } from './sales.js';

// Дата в строке: «01.09», «1/9», «01.09.2026», «2026-09-01».
function parseDate(text, nowMs = Date.now()) {
  const iso = text.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const m = text.match(/\b(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?\b/);
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  if (day < 1 || day > 31 || month < 1 || month > 12) return null;
  let year = m[3] ? Number(m[3]) : new Date(nowMs).getUTCFullYear();
  if (year < 100) year += 2000;
  // Без года: дата в прошлом означает следующий год (заказ на будущее).
  const candidate = Date.UTC(year, month - 1, day);
  if (!m[3] && candidate < nowMs - 86_400_000 * 14) year += 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// Ставка: самое большое число от 4 цифр («95 000», «95000,50», «95т»).
function parseRate(text) {
  const cleaned = text.replace(/(\d)\s+(\d)/g, '$1$2');
  const numbers = [...cleaned.matchAll(/\b(\d{4,7})(?:[.,]\d{1,2})?\b/g)]
    .map(m => Number(m[1]))
    .filter(n => n >= 5000 && n <= 900_000);
  return numbers.length ? Math.max(...numbers) : 0;
}

// Количество машин: «2 маш», «x2», «2 авто», «2 ТС».
function parseCount(text) {
  const m = text.match(/(?:^|\s)[x×х]?\s?(\d{1,2})\s*(?:маш|авто|тс|ед)/i)
    || text.match(/\b(\d{1,2})\s*[x×х](?:\s|$)/);
  const n = m ? Number(m[1]) : 1;
  return n >= 1 && n <= 20 ? n : 1;
}

// Пара адресов из строки: сначала явные разделители направления, затем —
// табличные колонки, затем перебор точек справочника по вхождению.
function parsePlaces(data, line) {
  const stripped = line
    .replace(/\b\d{1,2}[./]\d{1,2}(?:[./]\d{2,4})?\b/g, ' ')
    .replace(/,?\s*[x×х]?\s?\d{1,2}\s*(?:маш\w*|авто|тс|ед\w*)/gi, ' ')
    .replace(/\b(\d)\s?\d{3,6}(?:[.,]\d{1,2})?\b/g, ' ');
  const arrows = stripped.split(/\s*(?:→|->|—>|=>|\sдо\s)\s*/);
  const candidates = [];
  const tryResolve = raw => {
    const text = raw.replace(/^[-–—•\s,;]+|[-–—•\s,;]+$/g, '');
    if (text.length < 3) return null;
    let address = resolveAddress(data, text) || cityAddress(data, text);
    // Падежи прописного текста («из Пензы в Москву»): срезаем окончание
    // последнего слова и пробуем ещё раз — «Пенз», «Москв» находятся префиксом.
    if (!address) {
      const trimmed = text.replace(/([а-яё]{4,})[аеиоуыюяьй]{1,2}$/i, '$1');
      if (trimmed !== text) address = resolveAddress(data, trimmed) || cityAddress(data, trimmed);
    }
    return { text, address: address || null };
  };
  if (arrows.length >= 2) {
    const from = tryResolve(arrows[0]);
    const to = tryResolve(arrows.slice(1).join(' '));
    if (from && to) return { from, to };
  }
  // Табличная строка: колонки через таб или «;» — ищем две адресные.
  const cols = line.split(/\t|;/).map(col => col.trim()).filter(Boolean);
  if (cols.length >= 2) {
    for (const col of cols) {
      const hit = tryResolve(col);
      if (hit && (hit.address || /[а-яё]{4,}/i.test(hit.text))) candidates.push(hit);
      if (candidates.length === 2) return { from: candidates[0], to: candidates[1] };
    }
  }
  // Свободный текст «из Пензы в Москву»: две самые длинные словесные части.
  const m = stripped.match(/из\s+(.{3,40}?)\s+(?:в|на)\s+(.{3,40})$/i);
  if (m) {
    const from = tryResolve(m[1]);
    const to = tryResolve(m[2]);
    if (from && to) return { from, to };
  }
  return null;
}

// Разбор всего текста письма: строка → черновик заявки (или пропуск).
export function parseMailOrders(data, text, nowMs = Date.now()) {
  const drafts = [];
  for (const rawLine of String(text || '').split(/\n+/)) {
    const line = rawLine.trim();
    if (line.length < 8) continue;
    const dateIso = parseDate(line, nowMs);
    const places = parsePlaces(data, line);
    if (!dateIso && !places) continue;
    const rate = parseRate(line);
    const count = parseCount(line);
    drafts.push({
      line,
      dateIso: dateIso || new Date(nowMs + 86_400_000).toISOString().slice(0, 10),
      dateGuessed: !dateIso,
      fromText: places?.from.address?.name || places?.from.text || '',
      toText: places?.to.address?.name || places?.to.text || '',
      fromResolved: Boolean(places?.from.address),
      toResolved: Boolean(places?.to.address),
      rate, count,
      ok: Boolean(dateIso && places?.from.address && places?.to.address)
    });
  }
  return drafts;
}

export function orderImportDialog(context) {
  const data = context.state.data;
  const customers = [...new Set((data.orders || []).map(order => order.customer_name))].sort();
  context.showModal(`<h2>📥 Заявки из письма</h2>
    <p class="muted">Вставьте текст письма клиента как есть — таблицей из Excel или прописью
      («01.09 Пенза, Аустрина 178 → Москва, Пермская 3, 95 000, 2 маш»). Каждая строка с датой
      или маршрутом станет черновиком; проверьте предпросмотр и создайте пакетом.
      Геозоны определятся по пунктам сами.</p>
    <label class="field">Клиент
      <input id="oiCustomer" list="oiCustomers" placeholder="как в справочнике" autocomplete="off">
      <datalist id="oiCustomers">${customers.map(name => `<option>${escapeHtml(name)}</option>`).join('')}</datalist>
    </label>
    <label class="field">Текст письма
      <textarea id="oiText" rows="8" style="width:100%" placeholder="вставьте сюда"></textarea></label>
    <div class="modal-actions" style="justify-content:flex-start">
      <button type="button" class="button" id="oiParse">🔎 Распознать</button>
      <button type="button" class="button ghost" data-close>Закрыть</button>
    </div>
    <div id="oiPreview"></div>`, 'wide');

  document.getElementById('oiParse').onclick = () => {
    const drafts = parseMailOrders(data, document.getElementById('oiText').value);
    const preview = document.getElementById('oiPreview');
    if (!drafts.length) {
      preview.innerHTML = '<p class="muted">Не распознано ни одной строки: нужна дата (01.09) или маршрут с «→», «из … в …», либо табличные колонки.</p>';
      return;
    }
    preview.innerHTML = `<div class="scolh" style="margin-top:8px">Предпросмотр
        <span>${drafts.length}</span>
        <small class="muted" style="font-weight:400"> · поля можно править прямо здесь; ⚠ — пункт не найден в справочнике (заявка создастся, зону уточнит сервер или логист)</small></div>
      <div class="table-wrap" style="max-height:40vh;overflow:auto"><table style="font-size:12px">
        <tr><th></th><th>Дата</th><th>Погрузка</th><th>Выгрузка</th><th>Ставка с НДС</th><th>Машин</th></tr>
        ${drafts.map((draft, index) => `<tr data-oi-row="${index}">
          <td>${draft.ok ? '✓' : '⚠'}</td>
          <td><input data-oi="date" value="${draft.dateIso}" style="width:105px"
            title="${draft.dateGuessed ? 'Дата не найдена в строке — подставлено завтра' : ''}"></td>
          <td><input data-oi="from" value="${escapeHtml(draft.fromText)}" style="width:220px"
            class="${draft.fromResolved ? '' : 'warn-border'}"></td>
          <td><input data-oi="to" value="${escapeHtml(draft.toText)}" style="width:220px"
            class="${draft.toResolved ? '' : 'warn-border'}"></td>
          <td><input data-oi="rate" value="${draft.rate || ''}" style="width:90px" inputmode="numeric"></td>
          <td><input data-oi="count" value="${draft.count}" style="width:44px" inputmode="numeric"></td>
        </tr>`).join('')}
      </table></div>
      <div class="modal-actions" style="justify-content:flex-start">
        <button type="button" class="button" id="oiCreate">➕ Создать заявки</button>
        <small class="muted">строка без ставки получит рыночную по направлению</small>
      </div>`;

    document.getElementById('oiCreate').onclick = async () => {
      const customer = document.getElementById('oiCustomer').value.trim();
      if (!customer) { toast('Укажите клиента', 'error'); return; }
      const rows = [...preview.querySelectorAll('[data-oi-row]')];
      let created = 0;
      let failed = 0;
      for (const row of rows) {
        const value = key => row.querySelector(`[data-oi="${key}"]`).value.trim();
        const dateIso = value('date');
        const count = Math.max(1, Number(value('count')) || 1);
        const fromAddress = resolveAddress(data, value('from'));
        const toAddress = resolveAddress(data, value('to'));
        for (let i = 0; i < count; i += 1) {
          try {
            await api('/api/orders', { method: 'POST', body: JSON.stringify({
              confirmPast: true, // файл — осознанный источник, прошлые даты в нём законны
              customerName: customer,
              fromPoint: fromAddress?.name || value('from'),
              toPoint: toAddress?.name || value('to'),
              fromAddressId: fromAddress?.id || null, toAddressId: toAddress?.id || null,
              windowFrom: new Date(`${dateIso}T05:00:00.000Z`).toISOString(),
              windowTo: new Date(`${dateIso}T17:00:00.000Z`).toISOString(),
              rateVat: parseMoney(value('rate')) || 0,
              comment: `из письма: ${row.querySelector('[data-oi="from"]').value.slice(0, 60)}`
            }) });
            created += 1;
          } catch (error) {
            failed += 1;
            row.style.background = 'color-mix(in srgb, var(--bad) 12%, transparent)';
            row.title = error.message;
          }
        }
      }
      toast(`Создано заявок: ${created}${failed ? ` · с ошибкой: ${failed} (строки подсвечены — наведите за причиной)` : ''}`,
        failed ? 'error' : undefined);
      if (created && !failed) { context.closeModal(); context.onReload(); }
      else if (created) context.onReload();
    };
  };
}
