// ── Вкладка «💸 Затраты» — журнал фактических расходов (Э1+Э2 плана
// docs/costs-plan.md). Ручной ввод и импорт выгрузок Excel/CSV из
// личных кабинетов поставщиков: колонки сопоставляются с полями прямо
// в предпросмотре (как сверка 1С), разбор дат и сумм — канон на
// сервере, дедуп отпечатком строки. Видят reports:read и вносящие
// (бухгалтерия, руководитель, админ).
import { api, escapeHtml, money, renderInto, toast } from './api.js';
import { readXlsxRows } from './xlsx-lite.js';

const dayHuman = iso => {
  const [y, m, d] = String(iso || '').split('-');
  return d ? `${d}.${m}.${y.slice(2)}` : '';
};

// CSV: маленький разбор с кавычками; разделитель — каким чаще делят
// первую строку (; или ,). Для Excel-файлов работает xlsx-lite.
export function parseCsvRows(text) {
  const firstLine = text.slice(0, text.indexOf('\n') + 1 || text.length);
  const delimiter = (firstLine.match(/;/g) || []).length >= (firstLine.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell); cell = '';
      if (row.some(value => String(value).trim() !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some(value => String(value).trim() !== '')) rows.push(row);
  return rows;
}

// «🚓 Штрафы ГИБДД» — полный журнал постановлений из коннектора
// OnlineГИБДД (09.11): со скидками и ВИНОВНИКОМ — водителем, закреплённым
// за машиной в момент нарушения. В журнал затрат эти записи не попадают:
// оплаченные штрафы туда кладёт Dornet фактом списания (иначе задвоение).
function gibddBlock(state, g) {
  if (!g) return '';
  const ruDay = iso => iso ? String(iso).slice(0, 10).split('-').reverse().join('.') : '—';
  const open = Boolean(state.expGibddOpen);
  const head = `<div class="resctl" style="margin-top:14px">
    <button class="button ghost small" data-exp-gfines="1">${open ? '▾' : '▸'}</button>
    <strong>🚓 Штрафы ГИБДД</strong>
    ${g.enabled || g.unpaidCount || g.fines.length
    ? `<small class="muted">не оплачено <b>${g.unpaidCount}</b> на <b>${money(g.unpaidAmount)}</b>
        (суммы к оплате, со скидкой)${g.burning.length ? ` · <b>скидка 50 % горит у ${g.burning.length}</b> (порог ${g.warnDays} дн)` : ''}
        · за период ${g.fines.length}${g.last?.at ? ` · данные ЛК на ${ruDay(g.last.at)}` : ''}</small>`
    : '<small class="muted">коннектор OnlineГИБДД выключен — Настройки → Интеграции</small>'}
  </div>`;
  if (!open) return head;
  const rows = g.fines.slice(0, 200).map(fine => `<tr>
      <td class="mono">${ruDay(fine.offense_on)}${fine.offense_time ? ` ${escapeHtml(fine.offense_time)}` : ''}</td>
      <td class="mono">${escapeHtml(fine.plate || fine.auto_cdi)}</td>
      <td>${escapeHtml(fine.driver_name || '—')}</td>
      <td>${escapeHtml(fine.article_number)}<div class="muted"><small>${escapeHtml((fine.location || '').slice(0, 80))}</small></div></td>
      <td class="num">${fine.amount_discount != null && fine.amount_discount < fine.amount && fine.status === 'nopayed'
    ? `<s class="muted">${money(fine.amount)}</s> <b>${money(fine.amount_discount)}</b>` : `<b>${money(fine.amount)}</b>`}</td>
      <td class="mono">${fine.discount_until && fine.status === 'nopayed' ? ruDay(fine.discount_until) : '—'}</td>
      <td>${fine.status === 'payed' ? '<small class="muted">оплачен</small>'
    : fine.status === 'revoked' ? '<small class="muted">обжалован</small>'
      : '<b style="color:var(--bad,#c0392b)">не оплачен</b>'}</td>
    </tr>`).join('');
  return `${head}
    <table class="rtable">
      <thead><tr><th>Нарушение</th><th>Машина</th><th>Виновник (по закреплению)</th>
        <th>Статья · место</th><th class="num">Сумма</th><th>Скидка до</th><th>Статус</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="7" class="muted" style="padding:14px">Штрафов с нарушением в этом периоде нет.</td></tr>'}</tbody>
    </table>
    ${g.fines.length > 200 ? `<p class="muted" style="padding:6px">Показаны 200 из ${g.fines.length} — сузьте период.</p>` : ''}
    ${g.withoutSts.length ? `<p class="muted" style="padding:6px">Без СТС — не на мониторинге (${g.withoutSts.length}): ${g.withoutSts.slice(0, 30).map(escapeHtml).join(', ')}${g.withoutSts.length > 30 ? '…' : ''}</p>` : ''}
    ${g.last?.unknownCdi?.length ? `<p class="muted" style="padding:6px">В ЛК сервиса есть СТС, не найденные в планере: ${g.last.unknownCdi.length} (прицепы и выбывшие — это нормально).</p>` : ''}`;
}

export async function renderExpenses(container, context) {
  const { state, can } = context;
  const today = new Date().toISOString().slice(0, 10);
  state.expFrom ||= today.slice(0, 8) + '01'; // с начала месяца
  state.expTo ||= today;
  let data;
  try {
    data = await api(`/api/expenses?from=${state.expFrom}&to=${state.expTo}`);
  } catch (error) {
    container.innerHTML = `<p class="muted" style="padding:16px">${escapeHtml(error.message)}</p>`;
    return;
  }
  // Доступ персональный: кто видит вкладку, тот и ведёт журнал
  // (гость — только просмотр); категории — там же.
  const canWrite = Boolean(state.data.user.expensesAccess) && !Number(state.data.user.guest);
  const canCategories = canWrite;
  const categoryById = new Map(data.categories.map(category => [category.id, category]));
  const brandOf = value => String(value || '').split(' · ')[0].trim() || '— без поставщика';
  const filterCat = state.expCat || '';
  const filterSup = state.expSup || '';
  const items = data.items.filter(item => (!filterCat || item.category_id === filterCat)
    && (!filterSup || brandOf(item.supplier) === filterSup));

  // Структура учёта (решение 03.11): разворачивающиеся группы —
  // «Переменные/Постоянные затраты» со статьями внутри и «Поставщики»
  // (поставщик с единым счётом, как Dornet, — одной суммой за период).
  // Свёрнуто видны только заголовки с итогами; строка внутри — фильтр.
  state.expOpen ||= {};
  const kindSum = kind => data.summary.byKind.find(row => row.key === kind)
    || { sum: 0, net: 0, count: 0 };
  // Пометка природы статьи (принцип 03.11): агрегат/материал отдельно
  // от услуги/работы — шины ≠ шиномонтаж, запчасть ≠ ремонт.
  const natureMark = category => category
    ? ` <small class="muted">· ${category.nature === 'goods' ? 'материал' : 'услуга'}</small>` : '';
  const groupRow = (type, key, name, row, active) => `<button class="exp-row ${active ? 'active' : ''}"
      data-exp-${type}="${escapeHtml(key)}" title="${active ? 'Снять фильтр' : 'Показать в таблице только это'}">
      <span>${escapeHtml(name)}${type === 'cat' ? natureMark(categoryById.get(key)) : ''}</span>
      <b>${money(row.sum)}</b>
      <small class="muted">без НДС ${money(row.net)} · ${row.count} шт</small></button>`;
  const groupBlock = (id, head, rowsHtml) => `<div class="exp-grp">
      <button class="exp-ghead" data-exp-grp="${id}">
        <span class="exp-arrow">${state.expOpen[id] ? '▾' : '▸'}</span>${head}</button>
      ${state.expOpen[id] && rowsHtml ? `<div class="exp-rows">${rowsHtml}</div>` : ''}
    </div>`;
  const kindBlock = (kind, label) => {
    const rows = data.summary.byCategory
      .filter(row => (categoryById.get(row.key)?.kind || 'variable') === kind);
    if (!rows.length) return '';
    const total = kindSum(kind);
    return groupBlock(kind,
      `${label} <b>${money(total.sum)}</b> <small class="muted">без НДС ${money(total.net)} · ${total.count} шт</small>`,
      rows.map(row => groupRow('cat', row.key,
        categoryById.get(row.key)?.name || row.key, row, filterCat === row.key)).join(''));
  };
  const supplierBlock = () => {
    const rows = data.summary.bySupplier;
    if (!rows.length) return '';
    const lead = rows[0];
    return groupBlock('sup',
      `Поставщики <b>${escapeHtml(lead.key)} ${money(lead.sum)}</b>` +
      (rows.length > 1 ? ` <small class="muted">и ещё ${rows.length - 1}</small>` : ''),
      rows.map(row => groupRow('sup', row.key, row.key, row, filterSup === row.key)).join(''));
  };
  const filterNote = filterCat || filterSup
    ? `<div class="resctl" style="margin:4px 0"><small class="muted">Фильтр таблицы:</small>
        <b>${escapeHtml([categoryById.get(filterCat)?.name, filterSup].filter(Boolean).join(' · '))}</b>
        <button class="button ghost small" data-exp-reset="1">✕ снять</button></div>`
    : '';

  const tableRows = items.slice(0, 400).map(item => `<tr>
      <td class="mono">${dayHuman(item.spent_on)}</td>
      <td>${escapeHtml(categoryById.get(item.category_id)?.name || item.category_id)}</td>
      <td class="num"><b>${money(item.amount)}</b>${item.vat ? '' : ' <small class="muted" title="Сумма без НДС">б/НДС</small>'}</td>
      <td class="mono">${escapeHtml(item.vehicle_plate || '')}</td>
      <td>${escapeHtml(item.supplier || '')}</td>
      <td class="muted">${escapeHtml(item.doc_ref || '')}${item.note ? ` · ${escapeHtml(item.note)}` : ''}</td>
      <td class="muted"><small>${item.source === 'manual' ? escapeHtml(item.created_by_name || '')
    : item.source === 'api' ? '⚙ авто' : '📥 импорт'}</small></td>
      <td>${canWrite ? `<button class="button ghost small" data-exp-del="${item.id}" title="Удалить запись (с аудитом)">✕</button>` : ''}</td>
    </tr>`).join('');

  const html = `<div class="inc-page">
    <div class="resctl" style="margin-bottom:8px">
      <strong>💸 Затраты</strong>
      <label class="muted">с <input type="date" id="expFrom" value="${state.expFrom}"></label>
      <label class="muted">по <input type="date" id="expTo" value="${state.expTo}"></label>
      ${canWrite ? `<button class="button small" id="expAdd">➕ Добавить</button>
        <button class="button ghost small" id="expImport" title="Выгрузка из личного кабинета поставщика: колонки сопоставляются при загрузке">📥 Импорт Excel/CSV</button>` : ''}
      ${canCategories ? `<button class="button ghost small" id="expCats" title="Справочник категорий затрат">🗂 Категории</button>` : ''}
      <small class="muted">Итог периода: <b>${money(data.summary.total)}</b>
        · без НДС <b>${money(data.summary.totalNet)}</b> · записей ${data.summary.count}</small>
    </div>
    ${data.summary.count ? `<div class="exp-groups">
      ${kindBlock('variable', 'Переменные затраты')}
      ${kindBlock('fixed', 'Постоянные затраты')}
      ${supplierBlock()}
    </div>${filterNote}`
    : '<div class="resctl" style="margin-bottom:8px"><small class="muted">Журнал пуст — добавьте первую запись или загрузите выгрузку поставщика.</small></div>'}
    <table class="rtable">
      <thead><tr><th>День</th><th>Категория</th><th class="num">Сумма</th><th>Машина</th>
        <th>Поставщик</th><th>Документ / заметка</th><th>Кто</th><th></th></tr></thead>
      <tbody>${tableRows || '<tr><td colspan="8" class="muted" style="padding:14px">Записей за период нет.</td></tr>'}</tbody>
    </table>
    ${items.length > 400 ? `<p class="muted" style="padding:6px">Показаны 400 из ${items.length} записей — сузьте период или категорию.</p>` : ''}
    ${gibddBlock(state, data.gibdd)}
  </div>`;
  if (!renderInto(container, html)) return;

  const redraw = () => renderExpenses(container, context);
  container.querySelector('#expFrom').addEventListener('change', event => {
    state.expFrom = event.target.value; redraw();
  });
  container.querySelector('#expTo').addEventListener('change', event => {
    state.expTo = event.target.value; redraw();
  });
  container.querySelectorAll('[data-exp-gfines]').forEach(button =>
    button.addEventListener('click', () => {
      state.expGibddOpen = !state.expGibddOpen; redraw();
    }));
  container.querySelectorAll('[data-exp-grp]').forEach(button =>
    button.addEventListener('click', () => {
      state.expOpen[button.dataset.expGrp] = !state.expOpen[button.dataset.expGrp];
      redraw();
    }));
  container.querySelectorAll('[data-exp-cat]').forEach(button =>
    button.addEventListener('click', () => {
      state.expCat = button.dataset.expCat === filterCat ? '' : button.dataset.expCat;
      redraw();
    }));
  container.querySelectorAll('[data-exp-sup]').forEach(button =>
    button.addEventListener('click', () => {
      state.expSup = button.dataset.expSup === filterSup ? '' : button.dataset.expSup;
      redraw();
    }));
  container.querySelectorAll('[data-exp-reset]').forEach(button =>
    button.addEventListener('click', () => {
      state.expCat = '';
      state.expSup = '';
      redraw();
    }));
  container.querySelectorAll('[data-exp-del]').forEach(button =>
    button.addEventListener('click', async () => {
      if (!confirm('Удалить запись из журнала затрат?')) return;
      try {
        await api(`/api/expenses/${button.dataset.expDel}`, { method: 'DELETE' });
        toast('Запись удалена');
        redraw();
      } catch (error) { toast(error.message, 'error'); }
    }));

  // ➕ Ручной ввод — модалка (переживает тихий поллинг, щит не нужен).
  const addButton = container.querySelector('#expAdd');
  if (addButton) addButton.onclick = () => {
    const vehicles = [...(state.data.vehicles || [])]
      .sort((a, b) => String(a.plate).localeCompare(String(b.plate), 'ru'));
    context.showModal(`<h2>➕ Затрата</h2>
      <form id="expForm" class="fields">
        <label class="field">День<input type="date" name="day" value="${today}" required></label>
        <label class="field">Категория<select name="category" required>
          ${data.categories.filter(category => category.active).map(category =>
    `<option value="${category.id}">${escapeHtml(category.name)}</option>`).join('')}
        </select></label>
        <label class="field">Сумма, ₽ (как в документе)
          <input name="amount" required inputmode="decimal" placeholder="например: 15 320,50"></label>
        <label class="field"><input type="checkbox" name="vat" checked> в сумме есть НДС</label>
        <label class="field">Машина (не обязательно)<select name="vehicle">
          <option value="">— без привязки —</option>
          ${vehicles.map(vehicle => `<option value="${vehicle.id}">${escapeHtml(vehicle.plate)}</option>`).join('')}
        </select></label>
        <label class="field">Поставщик<input name="supplier" maxlength="120" placeholder="кому платили"></label>
        <label class="field">Документ<input name="doc" maxlength="120" placeholder="№ счёта / чека / УПД"></label>
        <label class="field">Заметка<input name="note" maxlength="300"></label>
        <div class="modal-actions">
          <button type="button" class="button ghost" data-close>Отмена</button>
          <button type="submit" class="button">Записать</button>
        </div>
      </form>`);
    document.getElementById('expForm').onsubmit = async event => {
      event.preventDefault();
      const form = event.target;
      try {
        await api('/api/expenses', { method: 'POST', body: JSON.stringify({
          spent_on: form.day.value, category_id: form.category.value,
          amount: form.amount.value, vat: form.vat.checked,
          vehicle_id: form.vehicle.value || undefined,
          supplier: form.supplier.value.trim(), doc_ref: form.doc.value.trim(),
          note: form.note.value.trim() }) });
        context.closeModal();
        toast('Затрата записана');
        redraw();
      } catch (error) { toast(error.message, 'error'); }
    };
  };

  // 📥 Импорт выгрузки: файл → строки → сопоставление колонок → загрузка.
  const importButton = container.querySelector('#expImport');
  if (importButton) importButton.onclick = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.xlsx,.csv';
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return;
      let rows;
      try {
        rows = file.name.toLowerCase().endsWith('.csv')
          ? parseCsvRows(await file.text())
          : await readXlsxRows(file);
      } catch (error) { toast(`Не прочитан файл: ${error.message}`, 'error'); return; }
      if (!rows.length) { toast('Файл пуст', 'error'); return; }
      importMappingDialog(rows, data.categories, context, redraw, file.name);
    };
    input.click();
  };

  // 🗂 Категории — живой справочник (active вместо удаления).
  const catsButton = container.querySelector('#expCats');
  if (catsButton) catsButton.onclick = () => {
    context.showModal(`<h2>🗂 Категории затрат</h2>
      <p class="muted">Характер: «ездовая» ложится на километры, «постоянная» — на
        машино-дни (пригодится живому нормативу себестоимости). Выключенная
        категория уходит из выбора, история не трогается.</p>
      <div class="list" style="max-height:300px;overflow:auto">
        ${data.categories.map(category => `<div class="list-item" style="gap:8px">
          <span style="flex:1;min-width:0"><strong style="${category.active ? '' : 'opacity:.5'}">${escapeHtml(category.name)}</strong>
            <small class="muted"> · ${category.kind === 'variable' ? 'ездовая (₽/км)' : 'постоянная (₽/машино-день)'}
            · ${category.nature === 'goods' ? 'материал/агрегат' : 'услуга/работа'}</small></span>
          <button type="button" class="button ghost small" data-cat-toggle="${category.id}"
            data-cat-active="${category.active}">${category.active ? '⏸ Выключить' : '▶ Включить'}</button>
        </div>`).join('')}
      </div>
      <form id="catForm" class="fields" style="margin-top:8px">
        <b>Новая категория</b>
        <input name="name" maxlength="80" required placeholder="Название">
        <select name="kind">
          <option value="variable">ездовая — ложится на километры</option>
          <option value="fixed">постоянная — ложится на машино-дни</option>
        </select>
        <select name="nature" title="Агрегат и работа учитываются раздельно: шины ≠ шиномонтаж">
          <option value="service">услуга / работа (ремонт, монтаж, мойка)</option>
          <option value="goods">материал / агрегат (шины, запчасти, топливо)</option>
        </select>
        <div class="modal-actions">
          <button type="button" class="button ghost" data-close>Закрыть</button>
          <button type="submit" class="button">➕ Добавить</button>
        </div>
      </form>`);
    document.querySelectorAll('[data-cat-toggle]').forEach(toggle =>
      toggle.addEventListener('click', async () => {
        try {
          await api(`/api/expense-categories/${toggle.dataset.catToggle}`, { method: 'PATCH',
            body: JSON.stringify({ active: toggle.dataset.catActive !== '1' }) });
          context.closeModal();
          redraw();
        } catch (error) { toast(error.message, 'error'); }
      }));
    document.getElementById('catForm').onsubmit = async event => {
      event.preventDefault();
      const form = event.target;
      try {
        await api('/api/expense-categories', { method: 'POST', body: JSON.stringify({
          name: form.name.value.trim(), kind: form.kind.value, nature: form.nature.value }) });
        toast('Категория добавлена');
        context.closeModal();
        redraw();
      } catch (error) { toast(error.message, 'error'); }
    };
  };
}

// Сопоставление колонок выгрузки с полями журнала: строка заголовков
// выбирается (угадывается первая «населённая»), для каждой нужной
// колонки — выпадашка; категория и НДС — одни на файл. Предпросмотр
// показывает сырые значения — канон разбора на сервере.
async function importMappingDialog(rows, categories, context, done, fileName = '') {
  const guessHeader = rows.findIndex(row =>
    (row || []).filter(cell => String(cell ?? '').trim() !== '').length >= 2);
  // Пресеты форматов (под выгрузки Автодора/Платона и любые другие):
  // отпечаток строки заголовков → сохранённое сопоставление. Повторный
  // файл того же формата узнаётся сам.
  let presets = {};
  try { presets = await api('/api/expenses/import-presets'); } catch { /* без пресетов */ }
  const fingerprintOf = header => (header || [])
    .map(cell => String(cell ?? '').trim().toLowerCase()).filter(Boolean)
    .join('|').slice(0, 300);
  const fields = [
    ['day', 'День *'], ['amount', 'Сумма *'], ['plate', 'Госномер'],
    ['supplier', 'Поставщик'], ['doc_ref', 'Документ'], ['note', 'Заметка']
  ];
  // Подсказки сопоставления по подписям колонок выгрузок.
  const hints = { day: /дата|день|date/i, amount: /сумма|итог|стоимост|amount|руб/i,
    plate: /номер тс|госномер|тс|автомобил|машин/i, supplier: /поставщик|азс|контрагент/i,
    doc_ref: /документ|счет|счёт|чек|№/i, note: /примеч|коммент|услуга|наименован/i };

  const build = headerIndex => {
    const header = rows[headerIndex] || [];
    const columns = header.map((cell, index) =>
      ({ index, label: String(cell ?? '').trim() || `колонка ${index + 1}` }));
    const options = selected => `<option value="">—</option>` + columns.map(column =>
      `<option value="${column.index}" ${selected === column.index ? 'selected' : ''}>${escapeHtml(column.label.slice(0, 40))}</option>`).join('');
    const guessFor = field => {
      const found = columns.find(column => hints[field]?.test(column.label));
      return found ? found.index : '';
    };
    return { columns, options, guessFor, dataRows: rows.slice(headerIndex + 1) };
  };

  let headerIndex = Math.max(0, guessHeader);
  const render = () => {
    const { options, guessFor, dataRows } = build(headerIndex);
    const preset = presets[fingerprintOf(rows[headerIndex])];
    const pick = field => preset?.mapping?.[field] ?? guessFor(field);
    const preview = dataRows.slice(0, 4);
    context.showModal(`<h2>📥 Импорт затрат</h2>
      ${preset ? `<p class="muted">✓ Формат узнан${preset.label ? ` («${escapeHtml(preset.label)}»)` : ''} —
        сопоставление и категория подставлены из прошлой загрузки.</p>` : ''}
      <form id="expImportForm" class="fields">
        <label class="field">Строка заголовков в файле
          <input type="number" name="header" min="1" max="${rows.length}" value="${headerIndex + 1}"
            title="Если шапка таблицы не в первой строке — укажите её номер"></label>
        ${fields.map(([field, label]) => `<label class="field">${label}
          <select name="${field}" ${field === 'day' || field === 'amount' ? 'required' : ''}>${options(pick(field))}</select></label>`).join('')}
        <label class="field">Категория всех строк файла<select name="category" required>
          ${categories.filter(category => category.active).map(category =>
    `<option value="${category.id}" ${preset?.category_id === category.id ? 'selected' : ''}>${escapeHtml(category.name)}</option>`).join('')}
        </select></label>
        <label class="field"><input type="checkbox" name="vat" ${preset && !preset.vat ? '' : 'checked'}> в суммах есть НДС</label>
        <p class="muted" style="margin:4px 0">Строк под заголовком: <b>${dataRows.length}</b>.
          Повторная загрузка того же файла дублей не создаст.</p>
        <div style="max-height:120px;overflow:auto"><table class="rtable"><tbody>
          ${preview.map(row => `<tr>${(row || []).slice(0, 8).map(cell =>
    `<td class="muted"><small>${escapeHtml(String(cell ?? '').slice(0, 18))}</small></td>`).join('')}</tr>`).join('')}
        </tbody></table></div>
        <div class="modal-actions">
          <button type="button" class="button ghost" data-close>Отмена</button>
          <button type="submit" class="button">📥 Загрузить</button>
        </div>
      </form>`);
    const form = document.getElementById('expImportForm');
    form.header.onchange = () => {
      headerIndex = Math.min(rows.length - 1, Math.max(0, Number(form.header.value) - 1));
      render();
    };
    form.onsubmit = async event => {
      event.preventDefault();
      const pick = field => form[field].value === '' ? null : Number(form[field].value);
      const cols = Object.fromEntries(fields.map(([field]) => [field, pick(field)]));
      const payloadRows = build(headerIndex).dataRows
        .map(row => ({
          spent_on: row?.[cols.day], amount: row?.[cols.amount],
          plate: cols.plate === null ? '' : row?.[cols.plate],
          supplier: cols.supplier === null ? '' : row?.[cols.supplier],
          doc_ref: cols.doc_ref === null ? '' : row?.[cols.doc_ref],
          note: cols.note === null ? '' : row?.[cols.note],
          category_id: form.category.value, vat: form.vat.checked
        }))
        .filter(row => row.spent_on !== undefined || row.amount !== undefined);
      if (!payloadRows.length) { toast('Под заголовком нет строк с данными', 'error'); return; }
      try {
        const result = await api('/api/expenses/import',
          { method: 'POST', body: JSON.stringify({ rows: payloadRows }) });
        context.closeModal();
        toast(`Загружено ${result.added} · пропущено ${result.skipped} (дубли и битые строки)`
          + (result.errors?.length ? ` · например: ${result.errors[0]}` : ''));
        // Формат запоминается: следующий файл с теми же заголовками
        // узнается сам (сопоставление, категория, НДС).
        api('/api/expenses/import-presets', { method: 'POST', body: JSON.stringify({
          fingerprint: fingerprintOf(rows[headerIndex]), mapping: cols,
          category_id: form.category.value, vat: form.vat.checked,
          headerIndex, label: fileName.replace(/\.[a-z]+$/i, '').slice(0, 60)
        }) }).catch(() => { /* пресет — удобство, не данные */ });
        done();
      } catch (error) { toast(error.message, 'error'); }
    };
  };
  render();
}
