// «▤ Мои отчёты» — экран «Система отчётов» (проект «Слияние», 07.11.2026)
// вместо разрозненных кнопок: реестр отчётов по уровням (День · Неделя ·
// Месяц · Процессы · Люди · Сверка · Архив) с отметкой отдела, источника
// цифр и уровня денег. Новых расчётов нет — кнопки открывают те же
// отчёты, что и раньше: openReport(kind), экран setView(view) или окно
// модуля. Фильтр по роли-набору — чистая функция reportsFor (reports-core.js).
import { escapeHtml, rangePickerHtml, toast, wireRangePicker } from './api.js';
import { DEPT_TITLES, MONEY_TITLES, REPORTS, groupByLevel, mergeCandidates, reportsFor, reportsLocked } from './reports-core.js';

export { REPORTS };

// Окна модулей — ленивой загрузкой: экран не тянет код отчётов, пока
// человек их не открыл. Сигнатуры — как у кнопок «Руководителя».
const DIALOGS = {
  mileage: async context => (await import('./boss.js')).mileageDialog(context),
  'ring-load': async context => (await import('./ring-load.js')).ringLoadDialog(context),
  shift: async context => (await import('./shift-report.js')).shiftDialog(context),
  project160: async context => (await import('./project160.js')).project160Dialog(context),
  demurrage: async context => (await import('./demurrage.js')).demurrageDialog(context),
  reconcile: async context => (await import('./reconcile.js')).reconcileDialog(context),
  'park-1c': async context => (await import('./park-report.js')).parkReportDialog(context),
  'self-tuning': async context => (await import('./self-tuning.js')).selfTuningDialog(context),
  inventory: async context => (await import('./inventory.js')).inventoryDialog(context, 'all')
};

const BOSS_TABS = { ops: '📍 Сегодня', eff: '📊 Неделя', month: '📅 Месяц', classic: '⋯ Отчёты и инструменты' };

function defaultPeriod(state) {
  const today = new Date().toISOString().slice(0, 10);
  return { from: state.reportsFrom || `${today.slice(0, 7)}-01`, to: state.reportsTo || today };
}

function howToOpen(report) {
  const open = report.open || {};
  if (open.kind) return 'окно с печатью и PDF';
  if (open.dialog) return 'окно отчёта';
  if (open.view === 'boss') return `«Руководитель» → ${BOSS_TABS[open.bossView] || 'экран'}`;
  if (open.view) return 'экран';
  if (open.feed) return open.feed;
  return '';
}

function actionHtml(report) {
  const open = report.open || {};
  if (open.feed) return '<span class="bi-tag" title="Рассылка приходит сама — в ленту чата">✉ рассылка</span>';
  const label = open.kind ? '📄 Сформировать' : open.view ? '→ Открыть' : '↗ Открыть';
  return `<button type="button" class="button small${open.kind ? ' primary' : ' ghost'}" data-rh-open="${escapeHtml(report.id)}">${label}</button>`;
}

function rowHtml(report, byId, showMerge) {
  const dup = report.duplicateOf ? byId.get(report.duplicateOf) : null;
  const flag = showMerge && (report.drop || report.merge)
    ? `<div class="rh-flag ${report.drop ? 'drop' : 'merge'}" title="${escapeHtml(report.drop || report.merge)}">
        ${report.drop ? '✕ кандидат на удаление' : '⇄ кандидат на слияние'}${dup ? ` · дубль «${escapeHtml(dup.title)}»` : ''}
        <span>${escapeHtml(report.drop || report.merge)}</span></div>` : '';
  const depts = [report.dept, ...(report.alsoDepts || [])];
  return `<div class="rh-row${report.drop ? ' is-drop' : ''}">
    <div class="rh-main"><b>${escapeHtml(report.title)}</b>
      <div class="rh-meta">
        ${depts.map(dept => `<span class="bi-tag rh-dept dept-${dept || 'all'}">${escapeHtml(DEPT_TITLES[dept] || dept)}</span>`).join('')}
        <span class="bi-tag rh-money ${report.money}" title="Минимальный уровень денег роли">₽ ${escapeHtml(MONEY_TITLES[report.money] || report.money)}</span>
        <span class="rh-how">${escapeHtml(howToOpen(report))}</span></div>
      <div class="rh-src" title="Откуда цифры">⛁ ${escapeHtml(report.source)}</div>${flag}</div>
    <div class="rh-act">${actionHtml(report)}</div></div>`;
}

export async function renderReportsHub(container, context) {
  const { state } = context;
  const access = context.access ?? state.data?.user?.access ?? null;
  const can = typeof context.can === 'function' ? context.can : () => false;
  const visible = reportsFor(access, can);
  const locked = reportsLocked(access, can);
  const { from, to } = defaultPeriod(state);
  const byId = new Map(REPORTS.map(report => [report.id, report]));
  const showMerge = state.reportsMerge !== false;
  const legacy = !access || access.legacy;
  const area = legacy || access.scope?.all ? 'всё направление'
    : (access.scope?.depts || []).map(dept => DEPT_TITLES[dept] || dept).join(', ');
  const merges = mergeCandidates(visible);
  const levels = groupByLevel(visible);

  const levelHtml = level => `<section class="section rh-level">
      <div class="sec-h"><span class="st">${escapeHtml(level.title)}</span><span class="hint">${escapeHtml(level.hint)}</span>
        <div class="sec-actions"><span class="bi-tag">${level.items.length}</span></div></div>
      <div class="sec-b rh-list">${level.items.map(report => rowHtml(report, byId, showMerge)).join('')}</div></section>`;

  container.innerHTML = `<div class="bi-page rh-page">
    <div class="bi-sub"><h2>Реестр отчётов</h2>
      <p>Каждый отчёт — один раз, с источником цифр. Область: ${escapeHtml(area)} · деньги: ${escapeHtml(MONEY_TITLES[access?.money] || '—')}.</p>
      <div class="bi-actions">${rangePickerHtml('rhFrom', 'rhTo', from, to, 'период')}
        <label class="rh-check"><input type="checkbox" id="rhMerge"${showMerge ? ' checked' : ''}> дубли</label></div></div>
    <div class="bi-kpis">
      <div class="metric"><span class="l">Отчётов доступно</span><span class="v">${visible.length}</span><span class="d">из ${REPORTS.length} в реестре</span></div>
      <div class="metric ${merges.length ? 'warn' : 'pos'}"><span class="l">Кандидаты на слияние</span><span class="v">${merges.length}</span><span class="d">решение — по счётчику использования</span></div>
      ${locked.length ? `<div class="metric neg"><span class="l">Закрыто сервером</span><span class="v">${locked.length}</span><span class="d">свой отдел, но нет права</span></div>` : ''}
    </div>
    ${levels.length ? `<div class="rh-grid">${levels.map(levelHtml).join('')}</div>`
    : '<div class="bi-empty">Отчётов для вашей роли пока нет — обратитесь к руководителю направления.</div>'}
    ${locked.length ? `<section class="section rh-locked"><div class="sec-h"><span class="st">Отчёты отдела, закрытые правами сервера</span>
        <span class="hint">видно, чтобы руководитель решил: открыть или оставить</span></div>
      <div class="sec-b rh-list">${locked.map(({ report, reason }) => `<div class="rh-row is-locked">
        <div class="rh-main"><b>${escapeHtml(report.title)}</b><div class="rh-src">⛁ ${escapeHtml(report.source)}</div></div>
        <div class="rh-act"><span class="bi-tag neg">🔒 ${escapeHtml(reason)}</span></div></div>`).join('')}</div></section>` : ''}
  </div>`;

  wireRangePicker(container, 'rhFrom', 'rhTo', (a, b) => { state.reportsFrom = a; state.reportsTo = b; });
  for (const id of ['rhFrom', 'rhTo']) {
    container.querySelector(`#${id}`).onchange = event => {
      state[id === 'rhFrom' ? 'reportsFrom' : 'reportsTo'] = event.currentTarget.value;
    };
  }
  container.querySelector('#rhMerge').onchange = event => {
    state.reportsMerge = event.currentTarget.checked;
    renderReportsHub(container, context);
  };
  container.onclick = async event => {
    const button = event.target.closest('[data-rh-open]');
    if (!button) return;
    const report = byId.get(button.dataset.rhOpen);
    if (!report) return;
    const period = defaultPeriod(state);
    if (period.to < period.from) { toast('Дата «по» раньше даты «с»', 'error'); return; }
    context.trackUsage?.(`report:reports:${report.id}`);
    const open = report.open;
    try {
      if (open.kind) await context.openReport(open.kind, period.from, period.to);
      else if (open.view) {
        if (open.bossView) state.bossView = open.bossView;
        if (open.view === 'boss') { state.bossFrom = period.from; state.bossTo = period.to; }
        context.setView(open.view);
      } else if (open.dialog && DIALOGS[open.dialog]) {
        await DIALOGS[open.dialog]({ ...context, toast });
      }
    } catch (error) { toast(error.message, 'error'); }
  };
}
