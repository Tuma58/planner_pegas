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
  const canWrite = can('expenses:write');
  const myRoles = state.data.user.roles || [state.data.user.role];
  const canCategories = myRoles.some(role => ['manager', 'admin'].includes(role));
  const categoryById = new Map(data.categories.map(category => [category.id, category]));
  const filterCat = state.expCat || '';
  const items = filterCat ? data.items.filter(item => item.category_id === filterCat) : data.items;

  const catChip = row => {
    const category = categoryById.get(row.key);
    return `<button class="button ghost small ${filterCat === row.key ? 'active' : ''}"
      data-exp-cat="${row.key}" title="${row.count} записей · без НДС ${money(row.net)}">
      ${escapeHtml(category?.name || row.key)} <b>${money(row.sum)}</b></button>`;
  };

  const tableRows = items.slice(0, 400).map(item => `<tr>
      <td class="mono">${dayHuman(item.spent_on)}</td>
      <td>${escapeHtml(categoryById.get(item.category_id)?.name || item.category_id)}</td>
      <td class="num"><b>${money(item.amount)}</b>${item.vat ? '' : ' <small class="muted" title="Сумма без НДС">б/НДС</small>'}</td>
      <td class="mono">${escapeHtml(item.vehicle_plate || '')}</td>
      <td>${escapeHtml(item.supplier || '')}</td>
      <td class="muted">${escapeHtml(item.doc_ref || '')}${item.note ? ` · ${escapeHtml(item.note)}` : ''}</td>
      <td class="muted"><small>${item.source === 'manual' ? escapeHtml(item.created_by_name || '') : '📥 импорт'}</small></td>
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
    <div class="resctl" style="margin-bottom:8px;flex-wrap:wrap">
      ${filterCat ? `<button class="button ghost small" data-exp-cat="">✕ все категории</button>` : ''}
      ${data.summary.byCategory.map(catChip).join('')}
      ${data.summary.byCategory.length ? '' : '<small class="muted">Журнал пуст — добавьте первую запись или загрузите выгрузку поставщика.</small>'}
    </div>
    <table class="rtable">
      <thead><tr><th>День</th><th>Категория</th><th class="num">Сумма</th><th>Машина</th>
        <th>Поставщик</th><th>Документ / заметка</th><th>Кто</th><th></th></tr></thead>
      <tbody>${tableRows || '<tr><td colspan="8" class="muted" style="padding:14px">Записей за период нет.</td></tr>'}</tbody>
    </table>
    ${items.length > 400 ? `<p class="muted" style="padding:6px">Показаны 400 из ${items.length} записей — сузьте период или категорию.</p>` : ''}
  </div>`;
  if (!renderInto(container, html)) return;

  const redraw = () => renderExpenses(container, context);
  container.querySelector('#expFrom').addEventListener('change', event => {
    state.expFrom = event.target.value; redraw();
  });
  container.querySelector('#expTo').addEventListener('change', event => {
    state.expTo = event.target.value; redraw();
  });
  container.querySelectorAll('[data-exp-cat]').forEach(button =>
    button.addEventListener('click', () => {
      state.expCat = button.dataset.expCat === filterCat ? '' : button.dataset.expCat;
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
      importMappingDialog(rows, data.categories, context, redraw);
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
            <small class="muted"> · ${category.kind === 'variable' ? 'ездовая (₽/км)' : 'постоянная (₽/машино-день)'}</small></span>
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
          name: form.name.value.trim(), kind: form.kind.value }) });
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
function importMappingDialog(rows, categories, context, done) {
  const guessHeader = rows.findIndex(row =>
    (row || []).filter(cell => String(cell ?? '').trim() !== '').length >= 2);
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
    const preview = dataRows.slice(0, 4);
    context.showModal(`<h2>📥 Импорт затрат</h2>
      <form id="expImportForm" class="fields">
        <label class="field">Строка заголовков в файле
          <input type="number" name="header" min="1" max="${rows.length}" value="${headerIndex + 1}"
            title="Если шапка таблицы не в первой строке — укажите её номер"></label>
        ${fields.map(([field, label]) => `<label class="field">${label}
          <select name="${field}" ${field === 'day' || field === 'amount' ? 'required' : ''}>${options(guessFor(field))}</select></label>`).join('')}
        <label class="field">Категория всех строк файла<select name="category" required>
          ${categories.filter(category => category.active).map(category =>
    `<option value="${category.id}">${escapeHtml(category.name)}</option>`).join('')}
        </select></label>
        <label class="field"><input type="checkbox" name="vat" checked> в суммах есть НДС</label>
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
        done();
      } catch (error) { toast(error.message, 'error'); }
    };
  };
  render();
}
