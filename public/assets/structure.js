// Экран «Структура» (проект «Слияние», блок 1, 05.11.2026): обзор
// структуры направления СТ, как первая панель «Рабочей среды СТ», но на
// живых данных планера. Отдел → группа → должность: штат (цель) против
// факта (люди из «Сотрудников», водители — из Ресурса), вакансии, живой
// коэффициент каскада отдела из канона parkReportData. Паспорт должности
// и правка штата — здесь же, у кого полный доступ к кадрам.
import { api, escapeHtml, toast } from './api.js';

const PASSPORT = [
  ['gen', 'Общие положения'], ['qual', 'Квалификационные требования'], ['know', 'Должен знать'],
  ['func', 'Функции'], ['duties', 'Должностные обязанности'], ['rights', 'Права'],
  ['inter', 'Взаимодействие'], ['resp', 'Ответственность'], ['kpi', 'KPI']
];

const fmtPct = value => value == null ? '—' : `${String(value).replace('.', ',')}%`;
const lines = value => Array.isArray(value) ? value : value ? [value] : [];

export async function renderStructure(container, context) {
  let data;
  try {
    data = await api('/api/structure');
  } catch (error) {
    container.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    return;
  }
  const edit = Boolean(context.state.structureEdit && data.canEdit);
  const { totals, park, targets } = data;
  const koef = park?.koef ?? null;
  const tone = (value, target) => value == null ? '' : value >= target ? 'pos' : value >= target - 3 ? 'warn' : 'neg';
  const groupsOf = dept => data.groups.filter(group => group.dept === dept.key);
  const positionsOf = group => data.positions.filter(position => position.group === group.id);

  const positionRow = position => {
    const pct = position.headcount ? Math.min(100, Math.round(position.fact / position.headcount * 100)) : 100;
    const meter = position.fact >= position.headcount ? 'pos' : pct >= 80 ? 'warn' : 'neg';
    return `<button class="st-pos" data-pos="${position.id}" title="Люди на должности и паспорт">
      <span class="st-n">${position.n}</span>
      <span class="st-t">${escapeHtml(position.title)}</span>
      <span class="st-c"><b>${position.fact}</b>/${position.headcount}</span>
      <span class="bi-meter ${meter}"><i style="width:${pct}%"></i></span>
      ${position.vacancies ? `<span class="bi-tag neg" title="Вакансий">−${position.vacancies}</span>`
        : position.over ? `<span class="bi-tag warn" title="Сверх штата">+${position.over}</span>` : '<span></span>'}
    </button>`;
  };

  const deptSection = dept => {
    const target = targets?.[dept.coef];
    return `<section class="section ${data.scoped ? 'st-wide' : 's3'} dept-${dept.key} st-dept">
      <div class="sec-h"><span class="st">${escapeHtml(dept.name)}</span>
        <span class="owner-chip chip-${dept.key}" title="${escapeHtml(dept.note)}">${dept.coef}</span>
        <div class="sec-actions">${edit ? `<button class="button ghost small" data-add-group="${dept.key}" title="Новая группа отдела">＋ группа</button>` : ''}</div></div>
      <div class="sec-b">
        <div class="st-coef">
          <span class="metric-inline ${tone(dept.value, target)}"><b>${fmtPct(dept.value)}</b> ${dept.coef}</span>
          <span class="muted">цель ${fmtPct(target)}${dept.coef === 'КЭИП' ? ' · итог каскада' : ''}</span>
        </div>
        <div class="st-staff muted">штат <b>${dept.headcount}</b> · факт <b>${dept.fact}</b>${dept.vacancies ? ` · вакансий <b class="st-neg">${dept.vacancies}</b>` : ''}</div>
        ${groupsOf(dept).map(group => `<div class="st-group">
          <div class="st-gh"><span>${escapeHtml(group.name)}</span>
            ${edit ? `<button class="link-btn" data-rename-group="${group.id}" title="Переименовать группу">✎</button>
              <button class="link-btn" data-add-pos="${group.id}" title="Новая должность в группе">＋ должность</button>` : ''}</div>
          ${positionsOf(group).map(positionRow).join('') || '<div class="bi-empty">нет должностей</div>'}
        </div>`).join('')}
      </div>
    </section>`;
  };

  container.innerHTML = `<div class="bi-page st-page">
    <div class="bi-sub"><h2>${data.scoped ? `Структура · ${escapeHtml(data.depts.map(dept => dept.name).join(', '))}` : 'Структура направления СТ'}</h2>
      <p>Штат — цель структуры, факт — люди из «Сотрудников» и водители из «Ресурса». Коэффициенты — канон отчёта парка за 7 суток${park ? ` (${park.from.slice(8, 10)}.${park.from.slice(5, 7)}–${park.to.slice(8, 10)}.${park.to.slice(5, 7)})` : ''}.</p>
      <div class="bi-actions">${data.canEdit ? `<button class="button ${edit ? 'primary' : 'secondary'}" id="stEdit"
        title="Правка групп, должностей и штата — каждая правка пишется в журнал">${edit ? '✓ Готово' : '✎ Править структуру'}</button>` : ''}</div></div>
    ${data.scoped ? scopedTiles(data, tone) : `<div class="bi-kpis">
      <div class="metric dept-toir"><span class="l">ТС в списке</span><span class="v">${park?.fleet ?? '—'}<small>ТС</small></span><span class="d">база КТГ</span></div>
      <div class="metric dept-drv ${totals.drivers < totals.driverHeadcount ? 'warn' : ''}"><span class="l">Водители</span>
        <span class="v">${totals.drivers}<small>из ${totals.driverHeadcount}</small></span>
        <span class="d">${totals.driverHeadcount - totals.drivers > 0 ? `вакансий ${totals.driverHeadcount - totals.drivers}` : 'укомплектовано'}</span></div>
      <div class="metric dept-staff ${totals.officeFact < totals.officeHeadcount ? 'warn' : ''}"><span class="l">Аппарат</span>
        <span class="v">${totals.officeFact}<small>из ${totals.officeHeadcount}</small></span>
        <span class="d">${totals.officeHeadcount - totals.officeFact > 0 ? `вакансий ${totals.officeHeadcount - totals.officeFact}` : 'укомплектовано'}</span></div>
      <div class="metric hero ${tone(koef, targets?.КЭИП)}"><span class="l">Использование парка</span>
        <span class="v">${fmtPct(koef)}</span><span class="d">цель ${fmtPct(targets?.КЭИП)} · КТГ×КВЛ×КИП</span></div>
      <div class="metric ${totals.noRole ? 'warn' : ''}"><span class="l">Без роли в планере</span>
        <span class="v">${totals.noRole}<small>чел</small></span><span class="d">входа нет — роль назначается руками</span></div>
    </div>`}
    <div class="bi-grid">
      ${data.depts.map(deptSection).join('')}
      ${data.unplaced.length ? `<section class="section">
        <div class="sec-h"><span class="st">Без должности в структуре</span>
          <span class="hint">назначьте должность в карточке сотрудника («Сотрудники» → ✎ Данные)</span></div>
        <div class="sec-b st-unplaced">${data.unplaced.map(person =>
    `<span class="bi-tag">${escapeHtml(person.name)}${person.roleLabel ? ` · ${escapeHtml(person.roleLabel)}` : ''}</span>`).join(' ')}</div>
      </section>` : ''}
    </div>
  </div>`;

  const rerender = () => renderStructure(container, context);
  const editButton = container.querySelector('#stEdit');
  if (editButton) editButton.onclick = () => { context.state.structureEdit = !edit; rerender(); };
  container.onclick = async event => {
    const pos = event.target.closest('[data-pos]');
    if (pos) return positionDialog(context, data, data.positions.find(item => item.id === pos.dataset.pos), rerender);
    const addGroup = event.target.closest('[data-add-group]');
    if (addGroup) {
      const name = prompt('Название новой группы отдела');
      if (!name) return;
      return save(() => api('/api/structure/groups', { method: 'POST',
        body: JSON.stringify({ dept: addGroup.dataset.addGroup, name }) }), 'Группа добавлена', rerender);
    }
    const rename = event.target.closest('[data-rename-group]');
    if (rename) {
      const group = data.groups.find(item => item.id === rename.dataset.renameGroup);
      const name = prompt('Название группы', group?.name || '');
      if (!name || name === group?.name) return;
      return save(() => api('/api/structure/groups', { method: 'POST',
        body: JSON.stringify({ id: group.id, name }) }), 'Группа переименована', rerender);
    }
    const addPos = event.target.closest('[data-add-pos]');
    if (addPos) return newPositionDialog(context, data, addPos.dataset.addPos, rerender);
    return undefined;
  };
}

// Мини-структура отдела (поле управления, 07.11): плитки СВОЕГО отдела —
// его коэффициент против цели, штат, факт, вакансии; итогов направления
// (весь парк, КЭИП) руководитель отдела не видит.
function scopedTiles(data, tone) {
  return `<div class="bi-kpis">${data.depts.map(dept => {
    const target = data.targets?.[dept.coef];
    return `<div class="metric hero dept-${dept.key} ${tone(dept.value, target)}"><span class="l">${dept.coef} · ${escapeHtml(dept.name)}</span>
        <span class="v">${fmtPct(dept.value)}</span><span class="d">цель ${fmtPct(target)} · ${escapeHtml(dept.note)}</span></div>
      <div class="metric dept-${dept.key} ${dept.vacancies ? 'warn' : ''}"><span class="l">Штат отдела</span>
        <span class="v">${dept.fact}<small>из ${dept.headcount}</small></span>
        <span class="d">${dept.vacancies ? `вакансий ${dept.vacancies}` : 'укомплектовано'}</span></div>`;
  }).join('')}
    <div class="metric ${data.totals.noRole ? 'warn' : ''}"><span class="l">Без роли в планере</span>
      <span class="v">${data.totals.noRole}<small>чел</small></span><span class="d">входа нет — роль назначает руководитель</span></div>
  </div>`;
}

async function save(call, message, after) {
  try {
    await call();
    toast(message);
    after();
  } catch (error) { toast(error.message); }
}

function passportHtml(passport) {
  return PASSPORT.map(([key, label]) => {
    const items = lines(passport[key]);
    if (!items.length) return '';
    const body = key === 'kpi'
      ? `<table class="bi-table"><thead><tr><th>Показатель</th><th>Норма</th><th>Период</th></tr></thead><tbody>${items.map(row =>
        `<tr>${(Array.isArray(row) ? row : [row, '', '']).map(cell => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>`
      : `<ul>${items.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
    return `<details class="st-pp"${key === 'duties' || key === 'kpi' ? ' open' : ''}><summary>${label}</summary>${body}</details>`;
  }).join('');
}

// Карточка должности: люди, паспорт; правка — штат, название, группа и
// паспорт (у кого полный доступ к кадрам).
function positionDialog(context, data, position, after) {
  if (!position) return;
  const { showModal, closeModal } = context;
  const dept = data.depts.find(item => item.key === position.dept);
  const group = data.groups.find(item => item.id === position.group);
  const people = position.driverPool
    ? `<p class="muted">Водители ведутся в «Ресурсе» (график, явка, закрепление): сейчас <b>${position.fact}</b> из штата ${position.headcount}.</p>`
    : position.people.length
      ? `<table class="bi-table"><thead><tr><th>Сотрудник</th><th>Роль в планере</th></tr></thead><tbody>${position.people.map(person =>
        `<tr><td>${escapeHtml(person.name)}</td><td>${person.roleLabel ? escapeHtml(person.roleLabel) : '<span class="bi-tag warn">без роли · входа нет</span>'}</td></tr>`).join('')}</tbody></table>`
      : '<div class="bi-empty">На должности никого — назначьте в «Сотрудниках»</div>';
  const passport = position.passport || {};
  const editForm = data.canEdit ? `<details class="st-pp st-edit"><summary>✎ Править должность</summary>
    <form id="stPosForm">
      <label class="field">Название <input name="title" required value="${escapeHtml(position.title)}"></label>
      <div style="display:grid;grid-template-columns:1fr 2fr;gap:8px">
        <label class="field">Штат, чел <input name="headcount" type="number" min="0" step="1" value="${position.headcount}"></label>
        <label class="field">Группа <select name="group">${data.groups.filter(item => item.dept === position.dept).map(item =>
    `<option value="${item.id}" ${item.id === position.group ? 'selected' : ''}>${escapeHtml(item.name)}</option>`).join('')}</select></label>
      </div>
      <label class="field">Статус <input name="status" value="${escapeHtml(position.status)}"></label>
      <label class="field">Затраты ЦФО <select name="cfoView">
        <option value="" ${!position.cfoView ? 'selected' : ''}>не видит</option>
        <option value="dept" ${position.cfoView === 'dept' ? 'selected' : ''}>видит затраты своего отдела</option>
        <option value="all" ${position.cfoView === 'all' ? 'selected' : ''}>видит общий ЦФО направления</option>
      </select><small class="muted">экран «₽ ЦФО и затраты»; персональный доступ к затратам — отдельно, в Настройках</small></label>
      ${rolePicker(data, position.dept, position.roleSet)}
      ${position.people.length ? `<label style="display:inline-flex;gap:6px;align-items:center;margin:0 0 8px">
        <input type="checkbox" name="applyToPeople" checked style="width:auto;height:auto;flex:none;margin:0"> применить новые права к людям на должности (${position.people.length})</label>` : ''}
      ${PASSPORT.map(([key, label]) => `<label class="field">${label} <small class="muted">${key === 'kpi' ? 'строка: показатель | норма | период' : 'по пункту на строку'}</small>
        <textarea name="pp_${key}" rows="${key === 'gen' || key === 'duties' ? 5 : 3}">${escapeHtml(lines(passport[key])
    .map(item => Array.isArray(item) ? item.join(' | ') : item).join('\n'))}</textarea></label>`).join('')}
      <div class="form-error" id="stPosError"></div>
      <div class="modal-actions">
        ${position.driverPool ? '' : '<button type="button" class="button danger" id="stPosArchive" title="Только пустую должность">Упразднить</button>'}
        <button class="button primary">Сохранить</button></div>
    </form></details>` : '';
  showModal(`<div class="st-card">
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      <h2 style="margin:0">${escapeHtml(position.title)}</h2>
      <span class="owner-chip chip-${position.dept}">${escapeHtml(dept?.name || '')}</span>
    </div>
    <p class="muted" style="margin:4px 0 10px">${escapeHtml(group?.name || '')} · ${escapeHtml(position.status)} ·
      штат <b>${position.headcount}</b> · факт <b>${position.fact}</b>${position.vacancies ? ` · вакансий <b>${position.vacancies}</b>` : ''}</p>
    ${position.driverPool ? '' : `<p style="margin:8px 0" title="Набор прав: что видит и что может человек на должности">🔐 Права:
      <b>${escapeHtml(setTitle(data, position.roleSet) || 'без входа в планер')}</b></p>`}
    ${people}
    <h3 class="st-h3">Паспорт должности</h3>
    ${passportHtml(passport) || '<div class="bi-empty">Паспорт не заполнен</div>'}
    ${editForm}
    <div class="modal-actions"><button type="button" class="button ghost" data-close>Закрыть</button></div>
  </div>`);
  const form = document.querySelector('#stPosForm');
  if (!form) return;
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const values = new FormData(form);
    const pp = Object.fromEntries(PASSPORT.map(([key]) => {
      const rows = String(values.get(`pp_${key}`) || '').split('\n').map(item => item.trim()).filter(Boolean);
      return [key, key === 'kpi' ? rows.map(row => row.split('|').map(cell => cell.trim())) : rows];
    }));
    try {
      await api(`/api/structure/positions/${position.id}`, { method: 'PATCH', body: JSON.stringify({
        title: String(values.get('title') || '').trim(), headcount: Number(values.get('headcount')),
        group: String(values.get('group')), status: String(values.get('status') || ''),
        cfoView: String(values.get('cfoView') || ''), passport: pp,
        roleSet: await resolveRoleSet(form, data, position.dept), applyToPeople: values.get('applyToPeople') === 'on' }) });
      toast('Должность сохранена');
      closeModal(); after();
    } catch (error) { document.querySelector('#stPosError').textContent = error.message; }
  });
  wireRolePicker(form, data, position.dept);
  const archive = document.querySelector('#stPosArchive');
  if (archive) archive.onclick = async () => {
    if (!confirm(`Упразднить должность «${position.title}»?`)) return;
    try {
      await api(`/api/structure/positions/${position.id}`, { method: 'DELETE' });
      toast('Должность упразднена');
      closeModal(); after();
    } catch (error) { document.querySelector('#stPosError').textContent = error.message; }
  };
}

// ── Права должности (10.11): набор ролей + «новый набор» на основе ──
const MONEY_TITLE = { full: 'все деньги', rates: 'ставки', none: 'без денег' };
const MONEY_RANK = { full: 3, rates: 2, none: 1 };
const setTitle = (data, id) => (data.roleSets || []).find(set => set.id === id)?.title || (id ? id : '');
// Наборы отдела должности (+ «всё направление» только в Штабе).
const setsForDept = (data, dept) => (data.roleSets || [])
  .filter(set => !set.scope || set.scope === dept || (set.scope === 'all' && dept === 'staff'));

function rolePicker(data, dept, current = '') {
  if (!data.roleSets) return '';
  const sets = setsForDept(data, dept);
  const titles = window.plViewTitles || {};
  return `<label class="field">Права на должности (набор)
      <select name="roleSet">
        <option value="" ${!current ? 'selected' : ''}>— без входа в планер</option>
        ${sets.map(set => `<option value="${set.id}" ${set.id === current ? 'selected' : ''}>${escapeHtml(set.title)} · ${set.views.length} экр. · ${MONEY_TITLE[set.money] || ''}</option>`).join('')}
        <option value="__new">＋ Новый набор прав…</option>
      </select>
      <small class="muted">человеку, назначенному на должность, эти права отмечаются сами</small></label>
    <div class="st-pp hidden" id="stNewSet" style="padding:8px 10px;border:1px solid var(--line);border-radius:8px;margin-bottom:8px">
      <label class="field">Название набора <input name="nsTitle" placeholder="например: Аналитик логистики"></label>
      <label class="field">На основе <small class="muted">— от основы берутся права на изменения</small>
        <select name="nsBase">${sets.map(set => `<option value="${set.id}">${escapeHtml(set.title)}</option>`).join('')}</select></label>
      <div class="field"><span>Экраны</span><div class="st-roles" id="nsViews">${(data.allViews || []).map(view =>
    `<label><input type="checkbox" name="nsView" value="${view}"><span>${escapeHtml(titles[view] || view)}</span></label>`).join('')}</div></div>
      <label class="field">Деньги <select name="nsMoney">${['none', 'rates', 'full']
    .filter(level => MONEY_RANK[level] <= MONEY_RANK[data.myMoney || 'none'])
    .map(level => `<option value="${level}">${MONEY_TITLE[level]}</option>`).join('')}</select></label>
    </div>`;
}

function wireRolePicker(form, data, dept) {
  const select = form?.querySelector('[name="roleSet"]');
  if (!select) return;
  const box = form.querySelector('#stNewSet');
  const base = form.querySelector('[name="nsBase"]');
  // Основа отмечает свои экраны и деньги — дальше руководитель правит.
  const fill = () => {
    const set = setsForDept(data, dept).find(item => item.id === base.value);
    if (!set) return;
    form.querySelectorAll('[name="nsView"]').forEach(input => { input.checked = set.views.includes(input.value); });
    const money = form.querySelector('[name="nsMoney"]');
    if ([...money.options].some(option => option.value === set.money)) money.value = set.money;
  };
  select.addEventListener('change', () => {
    box.classList.toggle('hidden', select.value !== '__new');
    if (select.value === '__new') fill();
  });
  base?.addEventListener('change', fill);
}

// «＋ Новый набор…» выбран — сначала создаём набор, потом его id уходит
// в должность.
async function resolveRoleSet(form, data, dept) {
  const value = String(form.querySelector('[name="roleSet"]')?.value || '');
  if (value !== '__new') return value;
  const result = await api('/api/role-sets', { method: 'POST', body: JSON.stringify({
    title: String(form.querySelector('[name="nsTitle"]').value || '').trim(),
    base: form.querySelector('[name="nsBase"]').value,
    views: [...form.querySelectorAll('[name="nsView"]:checked')].map(input => input.value),
    money: form.querySelector('[name="nsMoney"]').value }) });
  data.roleSets = result.roleSets;
  return result.id;
}

// Новая должность: название, штат, права (набор или новый набор).
function newPositionDialog(context, data, groupId, after) {
  const { showModal, closeModal } = context;
  const group = data.groups.find(item => item.id === groupId);
  showModal(`<form id="stNewPos"><h2>＋ Новая должность</h2>
    <p class="muted">${escapeHtml(group?.name || '')}</p>
    <label class="field">Название <input name="title" required></label>
    <label class="field">Штат, чел <input name="headcount" type="number" min="0" step="1" value="1"></label>
    ${rolePicker(data, group?.dept, '')}
    <div class="form-error" id="stNewPosError"></div>
    <div class="modal-actions"><button type="button" class="button ghost" data-close>Отмена</button>
      <button class="button primary">Создать</button></div></form>`);
  const form = document.querySelector('#stNewPos');
  wireRolePicker(form, data, group?.dept);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const values = new FormData(form);
    try {
      const roleSet = await resolveRoleSet(form, data, group?.dept);
      await api('/api/structure/positions', { method: 'POST', body: JSON.stringify({
        group: groupId, title: String(values.get('title') || '').trim(),
        headcount: Number(values.get('headcount')), roleSet }) });
      toast('Должность добавлена');
      closeModal(); after();
    } catch (error) { document.querySelector('#stNewPosError').textContent = error.message; }
  });
}
