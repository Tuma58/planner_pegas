// «🚧 КПП» — рабочее место охранника-парковщика, стоянка базы в Пензе
// (проект «Слияние», 07.11.2026). Устройство взято из разработки «Журнал
// КПП ведомственной стоянки»: одна кнопка на номер (на стоянке — выезд,
// иначе въезд), время ставит сервер, «Сейчас на стоянке», «Забыли отметить
// выезд?», исправление и аннулирование с отметкой. Охранник — вошедший по
// своей учётке. Отметка факт рейса НЕ ставит: диспетчер получает подсказку.
import { api, escapeHtml, renderInto, toast } from './api.js';

const TYPE_ICON = { truck: '🚛', personal: '🚗', other: '🚙' };
const LAT2CYR = { A: 'А', B: 'В', E: 'Е', K: 'К', M: 'М', H: 'Н', O: 'О', P: 'Р', C: 'С', T: 'Т', Y: 'У', X: 'Х' };
const norm = value => String(value ?? '').toUpperCase().replace(/Ё/g, 'Е').split('')
  .map(ch => LAT2CYR[ch] || ch).join('').replace(/[^0-9А-Я]/g, '');
const time = iso => new Date(iso).toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' });
const dateTime = iso => iso ? new Date(iso).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
const dur = min => {
  min = Math.max(0, Math.round(min));
  if (min < 60) return `${min} мин`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} ч ${min % 60 ? `${min % 60} мин` : ''}`.trim();
  return `${Math.floor(h / 24)} сут ${h % 24 ? `${h % 24} ч` : ''}`.trim();
};
const minutesSince = iso => (Date.now() - Date.parse(iso)) / 60000;
const localInput = iso => {
  const d = new Date(Date.parse(iso) + 3 * 3_600_000);
  return d.toISOString().slice(0, 16);
};
const fromLocalInput = value => new Date(Date.parse(`${value}:00Z`) - 3 * 3_600_000).toISOString();

export async function renderGate(container, context) {
  try {
    context.state.gateData = await api('/api/gate');
  } catch (error) {
    container.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    return;
  }
  draw(container, context);
}

// Перерисовка без запроса к серверу — ввод номера, выбор типа, фильтры.
function draw(container, context) {
  const { state } = context;
  const data = state.gateData;
  const gs = state.gate ||= { plate: '', type: '', filter: '', tab: 'post' };
  const dir = new Map(data.dir.map(item => [item.plate, item]));
  const onsite = new Map(data.onsite.map(row => [row.plate, row]));
  const longMin = (data.longHours || 24) * 60;

  const preview = () => {
    const plate = norm(gs.plate);
    if (plate.length < 4) return { html: '<div class="muted">Введите госномер — система сама поймёт: въезд или выезд.</div>', kind: '' };
    const on = onsite.get(plate);
    if (on) {
      return { kind: 'out', html: `<div class="gt-ctx out">${TYPE_ICON[on.type]} <b>${escapeHtml(plate)}</b> на стоянке с ${time(on.entry_at)}
        · ${dur(minutesSince(on.entry_at))}${on.person ? ` · ${escapeHtml(on.person)}` : ''}</div>` };
    }
    const known = dir.get(plate);
    return { kind: 'in', known, html: known
      ? `<div class="gt-ctx in">${TYPE_ICON[known.type]} <b>${escapeHtml(plate)}</b> · ${escapeHtml(data.types[known.type])}${known.person ? ` · ${escapeHtml(known.person)}` : ''}${known.trailer ? ` · прицеп ${escapeHtml(known.trailer)}` : ''}</div>`
      : `<div class="gt-ctx new">Номера нет в справочнике — выберите тип</div>` };
  };
  const ctx = preview();
  const suggestions = gs.plate.length >= 2 ? data.dir.filter(item => item.plate.includes(norm(gs.plate))).slice(0, 6) : [];
  const list = data.onsite.filter(row => (!gs.filter || row.type === gs.filter)
    && (!gs.search || `${row.plate} ${row.person} ${row.trailer}`.toLowerCase().includes(gs.search.toLowerCase())));
  const counts = type => data.onsite.filter(row => row.type === type).length;

  // Щит ввода: номер, который печатают, переживает перерисовку и тихое
  // автообновление живым узлом (renderInto).
  if (!renderInto(container, `<div class="bi-page gt-page">
    <div class="bi-sub"><h2>КПП · стоянка базы, Пенза</h2>
      <p>Дежурный: <b>${escapeHtml(data.guard)}</b>. Время ставит сервер в момент нажатия. Отметка в рейс не ставится — диспетчер получает подсказку.</p>
      <div class="bi-actions"><span class="segmented">
        <button data-gt-tab="post" class="${gs.tab === 'post' ? 'active' : ''}">Пост</button>
        <button data-gt-tab="report" class="${gs.tab === 'report' ? 'active' : ''}">Отчёт</button>
        ${data.rights.dir ? `<button data-gt-tab="dir" class="${gs.tab === 'dir' ? 'active' : ''}">Справочник</button>` : ''}</span></div></div>
    <div class="bi-kpis">
      <div class="metric"><span class="l">На стоянке</span><span class="v">${data.onsite.length}</span>
        <span class="d">🚛 ${counts('truck')} · 🚗 ${counts('personal')} · 🚙 ${counts('other')}</span></div>
      <div class="metric"><span class="l">За сутки</span><span class="v">${data.today.entries}<small>въезд</small></span>
        <span class="d">выездов ${data.today.exits}</span></div>
    </div>
    ${gs.tab === 'post' ? `<div class="bi-grid">
      <section class="section s5 gt-reg">
        <div class="sec-h"><span class="st">Регистрация</span></div>
        <div class="sec-b">
          <input id="gtPlate" class="gt-plate" placeholder="А123ВС58" value="${escapeHtml(gs.plate)}" autocomplete="off" inputmode="text">
          ${suggestions.length ? `<div class="gt-suggest">${suggestions.map(item => `<button data-gt-pick="${item.plate}">${TYPE_ICON[item.type]} ${escapeHtml(item.plate)}
            <small>${escapeHtml(item.person || '')}</small></button>`).join('')}</div>` : ''}
          ${ctx.html}
          ${ctx.kind === 'in' ? `
            ${ctx.known ? '' : `<div class="gt-types">${Object.entries(data.types).map(([key, label]) =>
    `<button data-gt-type="${key}" class="${gs.type === key ? 'active' : ''}">${TYPE_ICON[key]} ${label}</button>`).join('')}</div>`}
            <input id="gtPerson" placeholder="Водитель / владелец" value="${escapeHtml(gs.person || ctx.known?.person || '')}">
            ${(ctx.known?.type || gs.type) === 'truck' ? `<input id="gtTrailer" placeholder="Прицеп" value="${escapeHtml(gs.trailer || ctx.known?.trailer || '')}">` : ''}
            ${!ctx.known && gs.type && gs.type !== 'truck' ? '<label class="gt-check"><input type="checkbox" id="gtAddDir" checked> запомнить номер в справочнике</label>' : ''}` : ''}
          ${ctx.kind ? '<input id="gtNote" placeholder="Примечание (необязательно)">' : ''}
          <button class="button primary gt-go ${ctx.kind}" id="gtGo" ${ctx.kind ? '' : 'disabled'}>${ctx.kind === 'out' ? '◀ Выезд' : ctx.kind === 'in' ? 'Въезд ▶' : 'Въезд / выезд'}</button>
        </div>
      </section>
      <section class="section s7">
        <div class="sec-h"><span class="st">Сейчас на стоянке</span>
          <span class="hint">личный транспорт дольше ${data.longHours} ч — подсвечен</span>
          <div class="sec-actions"><input id="gtSearch" placeholder="Поиск" value="${escapeHtml(gs.search || '')}" class="gt-search">
            <span class="segmented">${['', 'truck', 'personal', 'other'].map(key => `<button data-gt-filter="${key}" class="${gs.filter === key ? 'active' : ''}">${key ? TYPE_ICON[key] : 'Все'}</button>`).join('')}</span></div></div>
        <div class="sec-b flush"><table class="bi-table gt-list"><tbody>${list.map(row => {
    const min = minutesSince(row.entry_at);
    const long = row.type === 'personal' && min > longMin;
    return `<tr class="${long ? 'gt-long' : ''}"><td>${TYPE_ICON[row.type]} <b class="mono">${escapeHtml(row.plate)}</b>
        <div class="muted">${escapeHtml(row.person || '')}${row.trailer ? ` · прицеп ${escapeHtml(row.trailer)}` : ''}${row.entry_note ? ` · ${escapeHtml(row.entry_note)}` : ''}</div></td>
      <td class="num">${time(row.entry_at)}<div class="muted">${dur(min)}</div></td>
      <td class="gt-acts"><button class="button small" data-gt-out="${row.id}" data-plate="${row.plate}">◀ Выезд</button>
        <button class="button small ghost" data-gt-late="${row.id}" title="Забыли отметить выезд? Укажите фактическое время">🕓</button>
        <button class="button small ghost" data-gt-edit="${row.id}" title="Исправить запись — с отметкой">✎</button></td></tr>`;
  }).join('') || '<tr><td class="muted">на стоянке никого</td></tr>'}</tbody></table></div>
      </section></div>` : gs.tab === 'report' ? reportHtml(gs) : dirHtml(data)}
  </div>`)) return;

  wire(container, context, data, gs, ctx);
}

function reportHtml(gs) {
  const today = new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
  return `<section class="section"><div class="sec-h"><span class="st">Отчёт за период</span>
      <div class="sec-actions"><input type="date" id="gtFrom" value="${gs.from || today}"> — <input type="date" id="gtTo" value="${gs.to || today}">
        <button class="button small" id="gtBuild">Сформировать</button>
        <button class="button small ghost" id="gtPrint">🖨 Печать</button></div></div>
    <div class="sec-b" id="gtReport"><div class="muted">Выберите период и нажмите «Сформировать».</div></div></section>`;
}

function dirHtml(data) {
  const own = data.dir.filter(item => item.type !== 'truck');
  return `<div class="bi-grid"><section class="section s4"><div class="sec-h"><span class="st">Добавить машину</span>
      <span class="hint">грузовые берутся из планера</span></div>
    <div class="sec-b gt-form"><input id="gdPlate" placeholder="Госномер"><select id="gdType"><option value="personal">🚗 Личный</option><option value="other">🚙 Сторонний</option></select>
      <input id="gdPerson" placeholder="Владелец"><input id="gdModel" placeholder="Марка, модель"><input id="gdDept" placeholder="Подразделение / организация">
      <button class="button primary" id="gdSave">Сохранить</button></div></section>
    <section class="section s8"><div class="sec-h"><span class="st">Личный и сторонний транспорт</span><span class="hint">${own.length} номеров</span></div>
      <div class="sec-b flush"><table class="bi-table"><tbody>${own.map(item => `<tr><td>${TYPE_ICON[item.type]} <b class="mono">${escapeHtml(item.plate)}</b></td>
        <td>${escapeHtml(item.person)}</td><td>${escapeHtml(item.model)}</td><td>${escapeHtml(item.dept || '')}</td>
        <td><button class="button small ghost" data-gd-del="${item.plate}">✕</button></td></tr>`).join('') || '<tr><td class="muted">пусто</td></tr>'}</tbody></table></div></section></div>`;
}

async function buildReport(container, gs, data) {
  const from = new Date(Date.parse(`${gs.from}T00:00:00Z`) - 3 * 3_600_000).toISOString();
  const to = new Date(Date.parse(`${gs.to}T00:00:00Z`) + 864e5 - 3 * 3_600_000).toISOString();
  const box = container.querySelector('#gtReport');
  try {
    const r = await api(`/api/gate/report?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    const table = (title, rows, label) => `<h3 class="gt-h3">${title}</h3><table class="bi-table"><thead><tr><th>${label}</th><th class="r">Визитов</th><th class="r">Время на стоянке</th></tr></thead>
      <tbody>${rows.map(row => `<tr><td>${escapeHtml(label === 'Тип' ? `${TYPE_ICON[row.key]} ${data.types[row.key]}` : row.key || '—')}</td><td class="num">${row.visits}</td><td class="num">${dur(row.minutes)}</td></tr>`).join('')}</tbody></table>`;
    box.innerHTML = `<p>Визитов <b>${r.visits.length}</b>${r.cancelled ? ` · аннулировано ${r.cancelled}` : ''}</p>
      ${table('По типам транспорта', r.byType, 'Тип')}${table('По охранникам (кто впустил)', r.byGuard, 'Охранник')}${table('По автомобилям', r.byPlate.slice(0, 50), 'Госномер')}
      <h3 class="gt-h3">Журнал въездов и выездов</h3><table class="bi-table"><thead><tr><th>Госномер</th><th>Въезд</th><th>Впустил</th><th>Выезд</th><th>Выпустил</th><th class="r">Стоял</th><th>Отметки</th></tr></thead>
      <tbody>${r.visits.map(visit => `<tr><td>${TYPE_ICON[visit.type]} <b class="mono">${escapeHtml(visit.plate)}</b></td><td>${dateTime(visit.entry_at)}</td>
        <td>${escapeHtml(visit.entry_by)}</td><td>${visit.exit_at ? dateTime(visit.exit_at) : '<i>на стоянке</i>'}</td><td>${escapeHtml(visit.exit_by)}</td>
        <td class="num">${dur(visit.minutes)}</td><td class="muted">${escapeHtml(visit.edits)}</td></tr>`).join('')}</tbody></table>`;
  } catch (error) { box.textContent = error.message; }
}

function wire(container, context, data, gs, ctx) {
  const rerender = () => renderGate(container, context);
  const redraw = () => draw(container, context);
  const plate = container.querySelector('#gtPlate');
  if (plate) {
    plate.oninput = () => {
      gs.plate = plate.value;
      gs.type = ''; gs.person = ''; gs.trailer = '';
      redraw();
    };
    plate.onkeydown = event => { if (event.key === 'Enter') container.querySelector('#gtGo')?.click(); };
  }
  const search = container.querySelector('#gtSearch');
  if (search) search.onchange = () => { gs.search = search.value; redraw(); };
  container.querySelector('#gtGo')?.addEventListener('click', async event => {
    event.currentTarget.disabled = true;
    try {
      const body = { plate: gs.plate, type: gs.type || undefined,
        person: container.querySelector('#gtPerson')?.value, trailer: container.querySelector('#gtTrailer')?.value,
        note: container.querySelector('#gtNote')?.value, addDir: container.querySelector('#gtAddDir')?.checked };
      const result = await api('/api/gate/register', { method: 'POST', body: JSON.stringify(body) });
      toast(`${result.kind === 'in' ? 'Въезд' : 'Выезд'}: ${result.plate}${result.hinted.includes('dispatcher') ? ' — диспетчер получил подсказку' : ''}`);
      Object.assign(gs, { plate: '', type: '', person: '', trailer: '' });
      // Щит ввода проносит живое поле — очищаем его явно, иначе номер останется.
      const input = container.querySelector('#gtPlate');
      if (input) input.value = '';
      rerender();
    } catch (error) {
      toast(error.message === 'NEED_TYPE' ? 'Выберите тип транспорта' : error.message);
      event.currentTarget.disabled = false;
    }
  });
  if (gs.tab === 'report') {
    container.querySelector('#gtBuild').onclick = () => {
      gs.from = container.querySelector('#gtFrom').value;
      gs.to = container.querySelector('#gtTo').value;
      buildReport(container, gs, data);
    };
    container.querySelector('#gtPrint').onclick = () => window.print();
  }
  if (gs.tab === 'dir') {
    container.querySelector('#gdSave').onclick = async () => {
      try {
        await api('/api/gate/dir', { method: 'POST', body: JSON.stringify({ plate: container.querySelector('#gdPlate').value,
          type: container.querySelector('#gdType').value, person: container.querySelector('#gdPerson').value,
          model: container.querySelector('#gdModel').value, dept: container.querySelector('#gdDept').value }) });
        toast('Сохранено');
        rerender();
      } catch (error) { toast(error.message); }
    };
  }
  container.onclick = async event => {
    const t = event.target;
    const tab = t.closest('[data-gt-tab]');
    if (tab) { gs.tab = tab.dataset.gtTab; redraw(); return; }
    const pick = t.closest('[data-gt-pick]');
    if (pick) { gs.plate = pick.dataset.gtPick; redraw(); return; }
    const type = t.closest('[data-gt-type]');
    if (type) {
      gs.type = type.dataset.gtType;
      gs.person = container.querySelector('#gtPerson')?.value || '';
      redraw();
      return;
    }
    const filter = t.closest('[data-gt-filter]');
    if (filter) { gs.filter = filter.dataset.gtFilter; redraw(); return; }
    const out = t.closest('[data-gt-out]');
    if (out) {
      try {
        const result = await api('/api/gate/register', { method: 'POST', body: JSON.stringify({ plate: out.dataset.plate }) });
        toast(`Выезд: ${result.plate}`);
        rerender();
      } catch (error) { toast(error.message); }
      return;
    }
    const late = t.closest('[data-gt-late]');
    if (late) return lateDialog(context, data.onsite.find(row => row.id === late.dataset.gtLate), rerender);
    const edit = t.closest('[data-gt-edit]');
    if (edit) return editDialog(context, data.onsite.find(row => row.id === edit.dataset.gtEdit), rerender);
    const del = t.closest('[data-gd-del]');
    if (del && confirm(`Удалить ${del.dataset.gdDel} из справочника?`)) {
      try { await api(`/api/gate/dir?plate=${encodeURIComponent(del.dataset.gdDel)}`, { method: 'DELETE' }); rerender(); } catch (error) { toast(error.message); }
    }
    return undefined;
  };
}

function lateDialog(context, row, after) {
  if (!row) return;
  context.showModal(`<form id="gtLateForm"><h2>Выезд задним числом · ${escapeHtml(row.plate)}</h2>
    <p class="muted">Въезд ${dateTime(row.entry_at)}. Укажите фактическое время выезда — запись получит отметку «выезд задним числом».</p>
    <label class="field">Время выезда (МСК) <input type="datetime-local" name="at" required value="${localInput(new Date().toISOString())}"></label>
    <div class="form-error" id="gtLateErr"></div>
    <div class="modal-actions"><button type="button" class="button ghost" data-close>Отмена</button><button class="button primary">Отметить выезд</button></div></form>`);
  document.querySelector('#gtLateForm').addEventListener('submit', async event => {
    event.preventDefault();
    try {
      await api(`/api/gate/${row.id}/exit`, { method: 'POST', body: JSON.stringify({ at: fromLocalInput(event.currentTarget.at.value) }) });
      context.closeModal(); after();
    } catch (error) { document.querySelector('#gtLateErr').textContent = error.message; }
  });
}

function editDialog(context, row, after) {
  if (!row) return;
  context.showModal(`<form id="gtEditForm"><h2>Запись на стоянке · ${escapeHtml(row.plate)}</h2>
    <label class="field">Время въезда (МСК) <input type="datetime-local" name="entryAt" required value="${localInput(row.entry_at)}"></label>
    <label class="field">Водитель / владелец <input name="person" value="${escapeHtml(row.person)}"></label>
    ${row.type === 'truck' ? `<label class="field">Прицеп <input name="trailer" value="${escapeHtml(row.trailer)}"></label>` : ''}
    <label class="field">Примечание <input name="note" value="${escapeHtml(row.entry_note)}"></label>
    <label class="field">Аннулировать — причина <input name="reason" placeholder="только если запись ошибочная"></label>
    <div class="form-error" id="gtEditErr"></div>
    <div class="modal-actions"><button type="button" class="button ghost" data-close>Отмена</button>
      <button type="button" class="button danger" id="gtCancelBtn">Аннулировать</button><button class="button primary">Сохранить</button></div></form>`);
  const form = document.querySelector('#gtEditForm');
  form.addEventListener('submit', async event => {
    event.preventDefault();
    try {
      await api(`/api/gate/${row.id}/edit`, { method: 'POST', body: JSON.stringify({ entryAt: fromLocalInput(form.entryAt.value),
        person: form.person.value, trailer: form.trailer?.value, note: form.note.value }) });
      context.closeModal(); after();
    } catch (error) { document.querySelector('#gtEditErr').textContent = error.message; }
  });
  document.querySelector('#gtCancelBtn').onclick = async () => {
    try {
      await api(`/api/gate/${row.id}/cancel`, { method: 'POST', body: JSON.stringify({ reason: form.reason.value }) });
      context.closeModal(); after();
    } catch (error) { document.querySelector('#gtEditErr').textContent = error.message; }
  };
}
