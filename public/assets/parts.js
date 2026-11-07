// Экран «🔩 Склад запчастей» (ТОиР, чек-лист продукта Б2.13, 07.11.2026):
// номенклатура и остатки, приход от поставщика, расход на заказ-наряд
// Ремзоны, инвентаризация, неснижаемый запас и список «к закупке»,
// заявки поставщику. Все числа считает сервер (src/parts.mjs):
// неснижаемый запас — живой норматив (расход за окно × срок поставки,
// выученный из факта «заявка → приход»), ручной минимум позиции главнее.
// Цены и суммы приходят только ролям с деньгами — без них поля не рисуются.
import { api, escapeHtml, money, toast, renderInto } from './api.js';

const TABS = [['stock', 'Остатки'], ['tobuy', 'К закупке'], ['requests', 'Заявки'], ['journal', 'Журнал'], ['norms', 'Нормативы']];
const LEAD_LABEL = { learned: 'по факту', manual: 'ручной', park: 'медиана склада', none: 'неизвестен' };
const MIN_LABEL = { manual: 'ручной', live: 'живой', no_use: 'нет расхода', no_lead: 'нет срока поставки' };
const KIND_LABEL = { receipt: 'приход', issue: 'на наряд', adjust: 'инвентаризация' };
const REQ_LABEL = { open: 'ждём', received: 'пришла', cancelled: 'отменена' };
const ORDER_LABEL = { queued: 'очередь', in_progress: 'в работе', ready: 'готов', released: 'выдан', cancelled: 'отменён' };

const attr = value => escapeHtml(value ?? '');
const ruDay = iso => iso ? String(iso).slice(0, 10).split('-').reverse().join('.') : '—';
const qtyFmt = value => value == null ? '—' : Number(value).toLocaleString('ru-RU', { maximumFractionDigits: 2 });
const rub = value => value == null ? '—' : money(value);
const todayIso = () => new Date().toLocaleDateString('en-CA');

function leadCell(lead) {
  if (lead.days == null) return '<span class="bi-tag warn" title="Нет фактов заявка→приход и не задан ручной срок">нет срока</span>';
  const hint = lead.source === 'learned' ? `медиана ${lead.samples} заявок` : lead.source === 'park' ? 'фактов позиции мало — медиана всего склада'
    : 'фактов мало — ручной срок позиции';
  return `${qtyFmt(lead.days)} сут <small class="muted" title="${attr(hint)}">${LEAD_LABEL[lead.source]}</small>`;
}
function minCell(item) {
  const m = item.min;
  if (m.qty == null) return `<span class="bi-tag warn" title="Расход есть, срок поставки неизвестен — заведите заявку поставщику или ручной срок">${MIN_LABEL[m.source]}</span>`;
  const live = m.source === 'manual' && m.live != null && m.live !== m.qty ? ` <small class="muted" title="Живой норматив по факту расхода">живой ${qtyFmt(m.live)}</small>` : '';
  return `${qtyFmt(m.qty)} <small class="muted">${MIN_LABEL[m.source]}</small>${live}`;
}
const stockCell = item => item.stock <= 0 ? `<span class="bi-tag neg">${qtyFmt(item.stock)}</span>`
  : item.below ? `<span class="bi-tag warn">${qtyFmt(item.stock)}</span>` : qtyFmt(item.stock);

function kpis(data) {
  const t = data.totals;
  return `<div class="bi-kpis">
    <div class="metric dept-toir hero"><span class="l">Позиций</span><span class="v">${t.items}</span><span class="d">${t.empty} без остатка</span></div>
    <div class="metric ${t.below ? 'warn' : 'pos'} clickable" data-parts-tab="tobuy"><span class="l">Ниже минимума</span><span class="v">${t.below}</span>
      <span class="d">к закупке ${t.toBuy} поз.${data.money && t.buyCost ? ` · ≈${rub(t.buyCost)}` : ''}</span></div>
    <div class="metric clickable" data-parts-tab="requests"><span class="l">Заявки в пути</span><span class="v">${t.openRequests}</span><span class="d">ждём от поставщиков</span></div>
    ${data.money ? `<div class="metric"><span class="l">Запас на складе</span><span class="v">${rub(t.stockValue)}</span>
      <span class="d">без НДС${t.noCost ? ` · без цены ${t.noCost} поз.` : ''}</span></div>` : ''}
    <div class="metric ${t.noLead ? 'warn' : ''}"><span class="l">Срок поставки неизвестен</span><span class="v">${t.noLead}</span>
      <span class="d">медиана склада ${data.parkLead.days != null ? `${qtyFmt(data.parkLead.days)} сут` : '—'}</span></div>
  </div>`;
}

function stockTab(data, state) {
  const q = (state.partsFilter || '').trim().toLowerCase();
  const onlyBelow = Boolean(state.partsOnlyBelow);
  const list = data.items.filter(item => (!q || `${item.name} ${item.code} ${item.category} ${item.supplier}`.toLowerCase().includes(q))
    && (!onlyBelow || item.below));
  return `${kpis(data)}
    <div class="bi-grid"><section class="section s12 dept-toir"><div class="sec-h"><span class="st">Остатки</span>
      <span class="hint">неснижаемый = расход за ${data.cfg.windowDays} сут × срок поставки${data.cfg.safetyFactor !== 1 ? ` × ${qtyFmt(data.cfg.safetyFactor)}` : ''}; ручной минимум главнее</span>
      <div class="sec-actions"><label class="parts-check"><input type="checkbox" id="partsOnlyBelow" ${onlyBelow ? 'checked' : ''}> ниже минимума</label>
        <input type="search" id="partsSearch" class="block-search" placeholder="Поиск: название, артикул" value="${attr(state.partsFilter || '')}"></div></div>
      <div class="sec-b flush">${list.length ? `<div class="bi-scroll"><table class="bi-table parts-table"><thead><tr>
        <th>Артикул</th><th>Наименование</th><th class="r">Остаток</th><th class="r">Заказано</th><th>Неснижаемый</th>
        <th>Срок поставки</th><th class="r">Расход/сут</th>${data.money ? '<th class="r">Ср. цена</th>' : ''}<th class="r">К закупке</th><th></th></tr></thead>
        <tbody>${list.map(item => `<tr class="parts-row${item.below ? ' parts-below' : ''}" data-parts-item="${attr(item.id)}">
          <td class="mono">${escapeHtml(item.code || '—')}</td>
          <td><b>${escapeHtml(item.name)}</b>${item.category ? ` <small class="muted">${escapeHtml(item.category)}</small>` : ''}</td>
          <td class="num">${stockCell(item)} <small class="muted">${escapeHtml(item.unit)}</small></td>
          <td class="num">${item.onOrder ? qtyFmt(item.onOrder) : '—'}</td>
          <td>${minCell(item)}</td><td>${leadCell(item.lead)}</td>
          <td class="num">${item.min.used ? qtyFmt(item.min.dailyUse) : '—'}${item.min.used && !item.windowFull ? ' <small class="muted" title="История позиции короче окна — расход в сутки занижен">неполн.</small>' : ''}</td>
          ${data.money ? `<td class="num">${rub(item.avgCost)}</td>` : ''}
          <td class="num">${item.toBuy ? `<b>${qtyFmt(item.toBuy)}</b>` : '—'}</td>
          <td class="parts-acts">${data.canWrite ? `<button type="button" class="button small ghost" data-parts-act="receipt" data-id="${attr(item.id)}" title="Приход">📦</button>
            <button type="button" class="button small ghost" data-parts-act="issue" data-id="${attr(item.id)}" title="На наряд">🔧</button>` : ''}</td>
        </tr>`).join('')}</tbody></table></div>`
    : `<div class="bi-empty">${data.items.length ? 'Ничего не найдено' : 'Склад пуст — заведите первую позицию кнопкой «＋ Позиция»'}</div>`}</div></section></div>`;
}

function toBuyTab(data) {
  const list = data.items.filter(item => item.toBuy > 0);
  return `${kpis(data)}
    <div class="bi-grid"><section class="section s12 dept-toir"><div class="sec-h"><span class="st">К закупке</span>
      <span class="hint">остаток + заказанное ниже неснижаемого; количество — до неснижаемого</span></div>
      <div class="sec-b flush">${list.length ? `<div class="bi-scroll"><table class="bi-table"><thead><tr>
        <th>Наименование</th><th>Поставщик</th><th class="r">Остаток</th><th class="r">Заказано</th><th>Неснижаемый</th><th>Срок поставки</th>
        <th class="r">Заказать</th>${data.money ? '<th class="r">≈ Сумма</th>' : ''}<th></th></tr></thead>
        <tbody>${list.map(item => `<tr data-parts-item="${attr(item.id)}" class="parts-row">
          <td><b>${escapeHtml(item.name)}</b> <small class="muted mono">${escapeHtml(item.code)}</small></td>
          <td>${escapeHtml(item.supplier || '—')}</td>
          <td class="num">${stockCell(item)} <small class="muted">${escapeHtml(item.unit)}</small></td>
          <td class="num">${item.onOrder ? qtyFmt(item.onOrder) : '—'}</td><td>${minCell(item)}</td><td>${leadCell(item.lead)}</td>
          <td class="num"><b>${qtyFmt(item.toBuy)}</b></td>
          ${data.money ? `<td class="num">${item.avgCost != null ? rub(Math.round(item.avgCost * item.toBuy)) : '—'}</td>` : ''}
          <td>${data.canWrite ? `<button type="button" class="button small" data-parts-act="request" data-id="${attr(item.id)}">📝 Заявка</button>` : ''}</td>
        </tr>`).join('')}</tbody></table></div>` : '<div class="bi-empty">Все позиции не ниже неснижаемого запаса</div>'}</div></section></div>`;
}

function requestsTab(data, reqs) {
  return `<div class="bi-grid"><section class="section s12 dept-toir"><div class="sec-h"><span class="st">Заявки поставщикам</span>
      <span class="hint">дата заявки → дата прихода = факт срока поставки, из него учится неснижаемый запас</span>
      ${data.canWrite ? '<div class="sec-actions"><button type="button" class="button small primary" data-parts-act="request">＋ Заявка</button></div>' : ''}</div>
    <div class="sec-b flush">${reqs.requests.length ? `<div class="bi-scroll"><table class="bi-table"><thead><tr>
      <th>Заявка от</th><th>Наименование</th><th class="r">Кол-во</th><th>Поставщик</th><th>Статус</th><th class="r">Дней</th><th>Приход</th><th>Кто</th><th></th></tr></thead>
      <tbody>${reqs.requests.map(row => `<tr>
        <td>${ruDay(row.requested_on)}</td><td>${escapeHtml(row.item_name)} <small class="muted mono">${escapeHtml(row.item_code)}</small></td>
        <td class="num">${qtyFmt(row.qty)} <small class="muted">${escapeHtml(row.unit)}</small></td><td>${escapeHtml(row.supplier || '—')}</td>
        <td><span class="bi-tag ${row.status === 'open' ? 'warn' : row.status === 'received' ? 'pos' : ''}">${REQ_LABEL[row.status]}</span></td>
        <td class="num">${row.waitDays == null ? '—' : qtyFmt(row.waitDays)}</td><td>${ruDay(row.received_on)}</td>
        <td><small class="muted">${escapeHtml(row.created_by_name)}</small></td>
        <td>${data.canWrite && row.status === 'open' ? `<button type="button" class="button small" data-parts-act="receipt" data-id="${attr(row.item_id)}" data-req="${attr(row.id)}">📦 Пришло</button>
          <button type="button" class="button small ghost" data-parts-req-cancel="${attr(row.id)}" title="Отменить заявку">✕</button>` : ''}</td>
      </tr>`).join('')}</tbody></table></div>` : '<div class="bi-empty">Заявок нет</div>'}</div></section></div>`;
}

// Знак движения: приход +, выдача −, инвентаризация — как есть.
const signedQty = row => {
  const value = row.kind === 'issue' ? -row.qty : row.qty;
  return `${value > 0 ? '+' : value < 0 ? '−' : ''}${qtyFmt(Math.abs(value))}`;
};

function movesTable(moves, { money: withMoney, canWrite, showItem = true }) {
  if (!moves.length) return '<div class="bi-empty">Движений нет</div>';
  return `<div class="bi-scroll"><table class="bi-table parts-moves"><thead><tr><th>День</th><th>Операция</th>${showItem ? '<th>Наименование</th>' : ''}
    <th class="r">Кол-во</th><th>Наряд · ТС / поставщик</th>${withMoney ? '<th class="r">Цена</th><th class="r">Сумма</th>' : ''}<th>Примечание</th><th>Кто</th><th></th></tr></thead>
    <tbody>${moves.map(row => `<tr class="${row.cancelled_at ? 'parts-cancelled' : ''}">
      <td>${ruDay(row.day)}</td><td>${KIND_LABEL[row.kind]}${row.cancelled_at ? ' <span class="bi-tag">отменено</span>' : ''}</td>
      ${showItem ? `<td>${escapeHtml(row.item_name)}</td>` : ''}
      <td class="num">${signedQty(row)} <small class="muted">${escapeHtml(row.unit)}</small></td>
      <td>${row.kind === 'issue' ? `<span class="mono">${escapeHtml(row.plate || '')}</span> <small class="muted">${escapeHtml(row.order_purpose || '')} · ${ORDER_LABEL[row.order_status] || ''}</small>`
        : `${escapeHtml(row.supplier || '')}${row.doc_ref ? ` <small class="muted">${escapeHtml(row.doc_ref)}</small>` : ''}`}</td>
      ${withMoney ? `<td class="num">${row.kind === 'receipt' ? `${rub(row.price)}${row.price != null ? ` <small class="muted">${row.vat ? 'с НДС' : 'без НДС'}</small>` : ''}` : row.kind === 'issue' ? `${rub(row.unit_cost_net)} <small class="muted">б/НДС</small>` : ''}</td>
        <td class="num">${rub(row.cost)}</td>` : ''}
      <td>${escapeHtml(row.cancelled_at ? `отмена: ${row.cancel_reason}` : row.note)}</td><td><small class="muted">${escapeHtml(row.created_by_name)}</small></td>
      <td>${canWrite && !row.cancelled_at ? `<button type="button" class="button small ghost" data-parts-cancel="${attr(row.id)}" title="Отменить движение (сторно)">↩</button>` : ''}</td>
    </tr>`).join('')}</tbody></table></div>`;
}

function journalTab(data, journal, state) {
  const kind = state.partsKind || '';
  return `<div class="bi-grid"><section class="section s12 dept-toir"><div class="sec-h"><span class="st">Журнал движений</span>
      <span class="hint">отмена не удаляет строку — остаток пересчитывается без неё</span>
      <div class="sec-actions"><span class="segmented">${[['', 'Все'], ['receipt', 'Приход'], ['issue', 'На наряд'], ['adjust', 'Инвентаризация']].map(([id, label]) =>
    `<button type="button" data-parts-kind="${id}" class="${id === kind ? 'active' : ''}">${label}</button>`).join('')}</span></div></div>
    <div class="sec-b flush">${movesTable(journal.moves, { money: data.money, canWrite: data.canWrite })}</div></section></div>`;
}

function normsTab(data) {
  const r = data.report;
  const c = data.cfg;
  const d = data.defaults;
  const field = (name, label, step, hint) => `<label class="field">${label}
    <input type="number" min="0" step="${step}" name="${name}" value="${c[name]}" ${data.canSettings ? '' : 'disabled'} placeholder="${d[name]}">
    <small class="muted">${hint}</small></label>`;
  return `<div class="bi-kpis">
      <div class="metric dept-toir"><span class="l">Срок поставки выучен</span><span class="v">${r.lead.learned}<small>из ${r.items}</small></span>
        <span class="d">ручной ${r.lead.manual} · по складу ${r.lead.park} · неизвестен ${r.lead.none}</span></div>
      <div class="metric"><span class="l">Медиана поставки склада</span><span class="v">${r.parkLead.days != null ? `${qtyFmt(r.parkLead.days)}<small>сут</small>` : '—'}</span>
        <span class="d">${r.parkLead.samples} фактов${r.rejected ? ` · отвергнуто ${r.rejected}` : ''}</span></div>
      <div class="metric"><span class="l">Ручной минимум</span><span class="v">${r.minManual}</span><span class="d">≠ живому у ${r.manualVsLive.length}</span></div>
      <div class="metric ${r.noLead ? 'warn' : ''}"><span class="l">Нет срока поставки</span><span class="v">${r.noLead}</span><span class="d">расход есть, запас не посчитан</span></div>
    </div>
    <div class="bi-grid">
      <section class="section s5 dept-toir"><div class="sec-h"><span class="st">Цели склада</span><span class="hint">${data.canSettings ? 'задаёт руководитель' : 'только просмотр'}</span></div>
        <div class="sec-b"><form id="partsCfgForm" class="fields">
          ${field('windowDays', 'Окно расхода, сут', 1, 'за сколько суток берём расход позиции')}
          ${field('minLeadSamples', 'Минимум фактов срока', 1, 'сколько закрытых заявок нужно, чтобы срок считался выученным')}
          ${field('leadMinDays', 'Коридор срока: от, сут', 0.5, 'факты короче — ошибка дат, в медиану не идут')}
          ${field('leadMaxDays', 'Коридор срока: до, сут', 1, 'факты длиннее — ошибка дат, в медиану не идут')}
          ${field('safetyFactor', 'Коэффициент запаса', 0.1, '1 — ровно на срок поставки; 0 — держим только ручной минимум')}
          <small class="muted">Затрата на запчасти — при закупке (журнал «Затраты»); выдача на наряд только списывает со склада.</small>
          ${data.canSettings ? '<div class="modal-actions"><button class="button primary">Сохранить цели</button></div>' : ''}
        </form></div></section>
      <section class="section s7"><div class="sec-h"><span class="st">Дрейф нормативов</span><span class="hint">строка для «📐 Нормативы недели»</span></div>
        <div class="sec-b"><p class="parts-line">${escapeHtml(r.line)}</p>
          ${r.manualVsLive.length ? `<table class="bi-table"><thead><tr><th>Позиция</th><th class="r">Ручной</th><th class="r">Живой</th></tr></thead>
            <tbody>${r.manualVsLive.map(row => `<tr class="parts-row" data-parts-item="${attr(row.id)}"><td>${escapeHtml(row.name)}</td>
              <td class="num">${qtyFmt(row.manual)}</td><td class="num">${qtyFmt(row.live)}</td></tr>`).join('')}</tbody></table>`
    : '<div class="bi-empty">Ручные минимумы совпадают с живыми или не заданы</div>'}</div></section>
    </div>`;
}

// ── Окна ──
const itemOptions = (items, selected) => items.map(item =>
  `<option value="${attr(item.id)}" ${item.id === selected ? 'selected' : ''}>${escapeHtml(item.name)}${item.code ? ` · ${escapeHtml(item.code)}` : ''} (остаток ${qtyFmt(item.stock)} ${escapeHtml(item.unit)})</option>`).join('');

function formDialog(context, { id, title, body, submit, url, method = 'POST', collect, done }) {
  context.showModal(`<form id="${id}" class="parts-form"><h2>${title}</h2>${body}
    <div class="form-error" id="${id}Err"></div>
    <div class="modal-actions"><button type="button" class="button ghost" data-close>Отмена</button><button class="button primary">${submit}</button></div></form>`);
  const form = document.getElementById(id);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    try {
      const result = await api(typeof url === 'function' ? url(form) : url, { method, body: JSON.stringify(collect(form)) });
      context.closeModal();
      done(result);
    } catch (error) { document.getElementById(`${id}Err`).textContent = error.message; }
  });
  return form;
}

function itemDialog(context, item, after) {
  const i = item || {};
  const form = formDialog(context, {
    id: 'partsItemForm', title: item ? 'Позиция склада' : 'Новая позиция склада', submit: 'Сохранить',
    url: item ? `/api/parts/items/${encodeURIComponent(item.id)}` : '/api/parts/items', method: item ? 'PATCH' : 'POST',
    body: `<label class="field">Наименование <input name="name" required value="${attr(i.name)}"></label>
      <label class="field">Артикул <input name="code" value="${attr(i.code)}"></label>
      <label class="field">Единица <input name="unit" value="${attr(i.unit || 'шт')}" placeholder="шт, л, кг, компл"></label>
      <label class="field">Группа <input name="category" value="${attr(i.category)}" placeholder="фильтры, тормоза, масла…"></label>
      <label class="field">Основной поставщик <input name="supplier" value="${attr(i.supplier)}"></label>
      <label class="field">Ручной минимум <input type="number" min="0" step="any" name="manualMin" value="${i.manualMin ?? ''}"
        placeholder="пусто — живой норматив"><small class="muted">Задан — заменяет живой неснижаемый запас</small></label>
      <label class="field">Срок поставки вручную, сут <input type="number" min="0" step="any" name="leadDaysManual" value="${i.leadDaysManual ?? ''}"
        placeholder="пусто — из факта заявок"><small class="muted">Работает, пока по позиции мало фактов «заявка → приход»</small></label>
      <label class="field">Примечание <textarea name="note" rows="2">${escapeHtml(i.note || '')}</textarea></label>
      ${item ? `<button type="button" class="button ghost small" id="partsArchive">${i.archived ? '↺ Вернуть из архива' : '🗄 В архив'}</button>` : ''}`,
    collect: f => Object.fromEntries(['name', 'code', 'unit', 'category', 'supplier', 'manualMin', 'leadDaysManual', 'note'].map(key => [key, f[key].value])),
    done: () => { toast('Позиция сохранена'); after(); }
  });
  const archive = form.querySelector('#partsArchive');
  if (archive) {
    archive.onclick = async () => {
      if (!i.archived && !confirm(`Убрать «${i.name}» в архив? Остаток и история сохранятся.`)) return;
      try {
        await api(`/api/parts/items/${encodeURIComponent(item.id)}`, { method: 'PATCH', body: JSON.stringify({ archived: !i.archived }) });
        context.closeModal(); toast(i.archived ? 'Позиция возвращена' : 'Позиция в архиве'); after();
      } catch (error) { document.getElementById('partsItemFormErr').textContent = error.message; }
    };
  }
}

async function receiptDialog(context, data, itemId, requestId, after) {
  let reqs = { requests: [] };
  try { reqs = await api('/api/parts/requests'); } catch { /* без заявок — приход без привязки */ }
  const open = reqs.requests.filter(row => row.status === 'open');
  const preset = open.find(row => row.id === requestId);
  const reqOptions = id => `<option value="">— без заявки —</option>${open.filter(row => !id || row.item_id === id).map(row =>
    `<option value="${attr(row.id)}" ${row.id === requestId ? 'selected' : ''}>от ${ruDay(row.requested_on)} · ${qtyFmt(row.qty)} · ${escapeHtml(row.supplier || 'без поставщика')}</option>`).join('')}`;
  const form = formDialog(context, {
    id: 'partsReceiptForm', title: '📦 Приход от поставщика', submit: 'Оприходовать', url: '/api/parts/receipts',
    body: `<label class="field">Позиция <select name="itemId" required><option value="">— выберите —</option>${itemOptions(data.items, itemId)}</select></label>
      <label class="field">По заявке <select name="requestId">${reqOptions(itemId)}</select>
        <small class="muted">Дата заявки и прихода учат срок поставки</small></label>
      <label class="field">Количество <input type="number" min="0" step="any" name="qty" required value="${preset ? preset.qty : ''}"></label>
      ${data.money ? `<label class="field">Цена за единицу, ₽ <input type="number" min="0" step="0.01" name="price" placeholder="как в накладной"></label>
        <label class="parts-check"><input type="checkbox" name="vat" checked> цена с НДС</label>` : ''}
      <label class="field">Поставщик <input name="supplier" value="${attr(preset?.supplier || '')}"></label>
      <label class="field">Документ <input name="docRef" placeholder="№ накладной / УПД"></label>
      <label class="field">День прихода <input type="date" name="day" value="${todayIso()}"></label>
      <label class="field">Примечание <input name="note"></label>`,
    collect: f => ({ itemId: f.itemId.value, requestId: f.requestId.value || null, qty: f.qty.value,
      price: f.price ? f.price.value : undefined, vat: f.vat ? f.vat.checked : undefined,
      supplier: f.supplier.value, docRef: f.docRef.value, day: f.day.value, note: f.note.value }),
    done: () => { toast('Приход оформлен'); after(); }
  });
  form.itemId.onchange = () => { form.requestId.innerHTML = reqOptions(form.itemId.value); };
}

async function issueDialog(context, data, itemId, after) {
  let orders = [];
  try { orders = (await api('/api/parts/orders')).orders; } catch (error) { toast(error.message, 'error'); return; }
  if (!orders.length) { toast('Открытых заказ-нарядов в Ремзоне нет — выдать не на что', 'error'); return; }
  formDialog(context, {
    id: 'partsIssueForm', title: '🔧 Расход на заказ-наряд', submit: 'Выдать', url: '/api/parts/issues',
    body: `<label class="field">Позиция <select name="itemId" required><option value="">— выберите —</option>${itemOptions(data.items.filter(item => item.stock > 0), itemId)}</select></label>
      <label class="field">Заказ-наряд Ремзоны <select name="orderId" required><option value="">— выберите —</option>${orders.map(order =>
    `<option value="${attr(order.id)}">${escapeHtml(order.plate)} · ${escapeHtml(order.purpose)} · ${ORDER_LABEL[order.status]}${order.complaint ? ` · ${escapeHtml(order.complaint.slice(0, 40))}` : ''}</option>`).join('')}</select></label>
      <label class="field">Количество <input type="number" min="0" step="any" name="qty" required></label>
      <label class="field">День <input type="date" name="day" value="${todayIso()}"></label>
      <label class="field">Примечание <input name="note" placeholder="какая работа"></label>`,
    collect: f => ({ itemId: f.itemId.value, orderId: f.orderId.value, qty: f.qty.value, day: f.day.value, note: f.note.value }),
    done: () => { toast('Выдано на наряд'); after(); }
  });
}

function adjustDialog(context, data, itemId, after) {
  formDialog(context, {
    id: 'partsAdjustForm', title: '⚖ Инвентаризация', submit: 'Записать факт', url: '/api/parts/adjust',
    body: `<label class="field">Позиция <select name="itemId" required>${itemOptions(data.items, itemId)}</select></label>
      <label class="field">Фактический остаток <input type="number" min="0" step="any" name="counted" required></label>
      <label class="field">Причина расхождения <input name="reason" required placeholder="пересчёт, брак, недостача…"></label>`,
    collect: f => ({ itemId: f.itemId.value, counted: f.counted.value, reason: f.reason.value }),
    done: result => { toast(`Остаток исправлен: ${result.delta > 0 ? '+' : ''}${qtyFmt(result.delta)}`); after(); }
  });
}

function requestDialog(context, data, itemId, after) {
  const item = data.items.find(row => row.id === itemId);
  const form = formDialog(context, {
    id: 'partsRequestForm', title: '📝 Заявка поставщику', submit: 'Записать заявку', url: '/api/parts/requests',
    body: `<label class="field">Позиция <select name="itemId" required><option value="">— выберите —</option>${itemOptions(data.items, itemId)}</select></label>
      <label class="field">Количество <input type="number" min="0" step="any" name="qty" required value="${item?.toBuy || ''}"></label>
      <label class="field">Поставщик <input name="supplier" value="${attr(item?.supplier || '')}"></label>
      <label class="field">Дата заявки <input type="date" name="day" value="${todayIso()}"></label>
      <label class="field">Примечание <input name="note"></label>`,
    collect: f => ({ itemId: f.itemId.value, qty: f.qty.value, supplier: f.supplier.value, day: f.day.value, note: f.note.value }),
    done: () => { toast('Заявка записана — ждём приход'); after(); }
  });
  form.itemId.onchange = () => {
    const picked = data.items.find(row => row.id === form.itemId.value);
    if (picked) { form.qty.value = picked.toBuy || ''; form.supplier.value = picked.supplier || ''; }
  };
}

async function itemCard(context, data, id, after) {
  let card;
  try { card = await api(`/api/parts/items/${encodeURIComponent(id)}`); } catch (error) { toast(error.message, 'error'); return; }
  const item = card.item;
  context.showModal(`<div class="parts-card"><div class="parts-card-head"><h2>${escapeHtml(item.name)}</h2>
      ${item.code ? `<span class="bi-tag mono">${escapeHtml(item.code)}</span>` : ''}${item.archived ? '<span class="bi-tag warn">архив</span>' : ''}
      ${card.canWrite ? '<button type="button" class="button small ghost" data-pc="edit">✎ Изменить</button>' : ''}</div>
    <div class="bi-kpis">
      <div class="metric dept-toir"><span class="l">Остаток</span><span class="v">${qtyFmt(item.stock)}<small>${escapeHtml(item.unit)}</small></span>
        <span class="d">заказано ${qtyFmt(item.onOrder)}</span></div>
      <div class="metric ${item.below ? 'warn' : ''}"><span class="l">Неснижаемый</span><span class="v">${item.min.qty == null ? '—' : qtyFmt(item.min.qty)}</span>
        <span class="d">${MIN_LABEL[item.min.source]}${item.min.source === 'manual' && item.min.live != null ? ` · живой ${qtyFmt(item.min.live)}` : ''}</span></div>
      <div class="metric"><span class="l">Срок поставки</span><span class="v">${item.lead.days == null ? '—' : `${qtyFmt(item.lead.days)}<small>сут</small>`}</span>
        <span class="d">${LEAD_LABEL[item.lead.source]} · фактов ${item.lead.samples}${item.lead.rejected ? ` · отвергнуто ${item.lead.rejected}` : ''}</span></div>
      <div class="metric"><span class="l">Расход за окно</span><span class="v">${qtyFmt(item.min.used)}</span>
        <span class="d">${qtyFmt(item.min.dailyUse)}/сут · типичная выдача ${qtyFmt(item.min.medianIssue)}</span></div>
      ${card.money ? `<div class="metric"><span class="l">Средняя цена</span><span class="v">${rub(item.avgCost)}</span><span class="d">без НДС</span></div>` : ''}
    </div>
    ${card.canWrite && !item.archived ? `<div class="bi-actions parts-card-acts">
      <button type="button" class="button small" data-pc="receipt">📦 Приход</button>
      <button type="button" class="button small" data-pc="issue">🔧 На наряд</button>
      <button type="button" class="button small ghost" data-pc="adjust">⚖ Инвентаризация</button>
      <button type="button" class="button small ghost" data-pc="request">📝 Заявка</button></div>` : ''}
    <section class="section"><div class="sec-h"><span class="st">Движения</span><span class="hint">последние 100</span></div>
      <div class="sec-b flush">${movesTable(card.moves, { money: card.money, canWrite: card.canWrite, showItem: false })}</div></section>
    <section class="section"><div class="sec-h"><span class="st">Заявки поставщику</span></div><div class="sec-b flush">
      ${card.requests.length ? `<table class="bi-table"><thead><tr><th>Заявка</th><th class="r">Кол-во</th><th>Поставщик</th><th>Статус</th><th>Приход</th></tr></thead>
        <tbody>${card.requests.map(row => `<tr><td>${ruDay(row.requested_on)}</td><td class="num">${qtyFmt(row.qty)}</td><td>${escapeHtml(row.supplier || '—')}</td>
          <td>${REQ_LABEL[row.status]}</td><td>${ruDay(row.received_on)}</td></tr>`).join('')}</tbody></table>` : '<div class="bi-empty">Заявок не было</div>'}</div></section>
    <div class="modal-actions"><button type="button" class="button ghost" data-close>Закрыть</button></div></div>`);
  document.querySelector('.parts-card').addEventListener('click', event => {
    const el = event.target.closest('[data-pc],[data-parts-cancel]');
    if (!el) return;
    if (el.dataset.partsCancel) { context.closeModal(); cancelMove(el.dataset.partsCancel, after); return; }
    context.closeModal();
    const act = el.dataset.pc;
    if (act === 'edit') itemDialog(context, item, after);
    else if (act === 'receipt') receiptDialog(context, data, id, null, after);
    else if (act === 'issue') issueDialog(context, data, id, after);
    else if (act === 'adjust') adjustDialog(context, data, id, after);
    else if (act === 'request') requestDialog(context, data, id, after);
  });
}

async function cancelMove(id, after) {
  const reason = prompt('Причина отмены движения (строка останется в журнале с отметкой):');
  if (reason == null) return;
  if (!reason.trim()) { toast('Без причины отмена не принимается', 'error'); return; }
  try {
    await api(`/api/parts/moves/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: JSON.stringify({ reason }) });
    toast('Движение отменено'); after();
  } catch (error) { toast(error.message, 'error'); }
}

// ── Экран ──
export async function renderParts(container, context) {
  const { state } = context;
  const tab = TABS.some(([id]) => id === state.partsTab) ? state.partsTab : 'stock';
  let data;
  let extra = null;
  try {
    if (tab === 'norms') {
      [data, extra] = await Promise.all([api('/api/parts/summary'), api('/api/parts/norms')]);
    } else {
      data = await api('/api/parts/summary');
      if (tab === 'requests') extra = await api('/api/parts/requests');
      if (tab === 'journal') extra = await api(`/api/parts/moves${state.partsKind ? `?kind=${encodeURIComponent(state.partsKind)}` : ''}`);
    }
  } catch (error) {
    container.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    return;
  }
  const reload = () => { renderParts(container, context); context.onReload?.(); };
  const draw = () => {
    const body = tab === 'tobuy' ? toBuyTab(data) : tab === 'requests' ? requestsTab(data, extra)
      : tab === 'journal' ? journalTab(data, extra, state) : tab === 'norms' ? normsTab({ ...extra, money: data.money }) : stockTab(data, state);
    renderInto(container, `<div class="bi-page svc-parts">
      <div class="bi-sub"><h2>Склад запчастей</h2>
        <p>Приход, расход на заказ-наряды Ремзоны, неснижаемый запас по факту расхода и сроку поставки.</p>
        <div class="bi-actions"><span class="segmented">${TABS.map(([id, label]) =>
    `<button type="button" data-parts-tab="${id}" class="${id === tab ? 'active' : ''}">${label}</button>`).join('')}</span>
          ${data.canWrite ? `<button type="button" class="button small primary" data-parts-act="item">＋ Позиция</button>
          <button type="button" class="button small" data-parts-act="receipt">📦 Приход</button>
          <button type="button" class="button small" data-parts-act="issue">🔧 На наряд</button>` : ''}</div></div>
      ${body}</div>`);
    const search = container.querySelector('#partsSearch');
    if (search) search.oninput = event => { state.partsFilter = event.currentTarget.value; draw(); };
    const below = container.querySelector('#partsOnlyBelow');
    if (below) below.onchange = event => { state.partsOnlyBelow = event.currentTarget.checked; draw(); };
    const cfgForm = container.querySelector('#partsCfgForm');
    if (cfgForm) {
      cfgForm.onsubmit = async event => {
        event.preventDefault();
        const body = Object.fromEntries(['windowDays', 'minLeadSamples', 'leadMinDays', 'leadMaxDays', 'safetyFactor'].map(key => [key, cfgForm[key].value]));
        try { await api('/api/parts/settings', { method: 'PUT', body: JSON.stringify(body) }); toast('Цели склада сохранены'); reload(); }
        catch (error) { toast(error.message, 'error'); }
      };
    }
  };
  draw();
  container.onclick = event => {
    const el = event.target.closest('[data-parts-tab],[data-parts-act],[data-parts-item],[data-parts-cancel],[data-parts-req-cancel],[data-parts-kind]');
    if (!el || el.closest('form')) return;
    if (el.dataset.partsTab) { state.partsTab = el.dataset.partsTab; renderParts(container, context); return; }
    if (el.dataset.partsKind !== undefined) { state.partsKind = el.dataset.partsKind; renderParts(container, context); return; }
    if (el.dataset.partsCancel) { cancelMove(el.dataset.partsCancel, reload); return; }
    if (el.dataset.partsReqCancel) {
      if (!confirm('Отменить заявку поставщику?')) return;
      api(`/api/parts/requests/${encodeURIComponent(el.dataset.partsReqCancel)}`, { method: 'PATCH', body: JSON.stringify({ action: 'cancel' }) })
        .then(() => { toast('Заявка отменена'); reload(); }).catch(error => toast(error.message, 'error'));
      return;
    }
    if (el.dataset.partsAct) {
      event.stopPropagation();
      const id = el.dataset.id || '';
      const act = el.dataset.partsAct;
      if (act === 'item') itemDialog(context, null, reload);
      else if (act === 'receipt') receiptDialog(context, data, id, el.dataset.req || null, reload);
      else if (act === 'issue') issueDialog(context, data, id, reload);
      else if (act === 'request') requestDialog(context, data, id, reload);
      return;
    }
    if (el.dataset.partsItem) itemCard(context, data, el.dataset.partsItem, reload);
  };
}
