// Экран «🎯 Проект 160»: наш с руководителем внутренний проект развития
// продукта. Главная гипотеза — деньги теряются на времени: на операциях и
// на передаче данных между участниками перевозки. Поэтому здесь не список
// «сделанных фич», а измеримая картина: где стоит время между ролями,
// сколько действий стоит работа и что дало каждое изменение продукта.
import { api, escapeHtml, money, toast } from './api.js';

const AREAS = ['Продажи', 'Логист', 'Диспетчер', 'Ресурс', 'Конвейер', 'Продукт'];
const STATUS = { todo: '⬜ в очереди', doing: '🔄 в работе', done: '✅ сделано', dropped: '✕ снято' };

const hoursLabel = value => value >= 24
  ? `${Math.round(value / 24 * 10) / 10} сут`
  : `${value} ч`;

// Сравнение с последним снимком: показываем не только «сколько сейчас»,
// но и «стало лучше или хуже» — иначе эффект работы недоказуем.
const deltaHtml = (current, before, { lessIsBetter = true, unit = 'ч' } = {}) => {
  if (before == null || !Number.isFinite(before) || before === 0) return '';
  const diff = Math.round((current - before) * 10) / 10;
  if (!diff) return '<span class="p160-delta same">без изменений</span>';
  const better = lessIsBetter ? diff < 0 : diff > 0;
  const pct = Math.round(Math.abs(diff) / before * 100);
  return `<span class="p160-delta ${better ? 'good' : 'bad'}">${diff > 0 ? '+' : '−'}${Math.abs(diff)} ${unit}
    (${better ? '−' : '+'}${pct}% ${better ? 'лучше' : 'хуже'})</span>`;
};

export async function project160Dialog(context) {
  let payload;
  try { payload = await api('/api/project160'); } catch (error) { toast(error.message, 'error'); return; }
  render(context, payload);
}

function render(context, payload) {
  const { handoffs, operations, money: cash, initiatives, snapshots, period } = payload;
  const base = snapshots[snapshots.length - 1]?.payload || null; // самый ранний снимок — базовый
  const prev = snapshots[0]?.payload || null;                     // последний снимок — для дельты
  const baseHandoff = key => base?.handoffs?.find(item => item.key === key)?.medianHours ?? null;
  const prevHandoff = key => prev?.handoffs?.find(item => item.key === key)?.medianHours ?? null;

  const total = handoffs.find(item => item.key === 'managed_chain');
  const withWait = handoffs.find(item => item.key === 'total_chain');
  // Цель берётся из плана выручки и считается БЕЗ НДС — так её ставит
  // руководитель. Факт приводим к той же базе, иначе сравнение бессмысленно.
  const goalNet = cash.targetNet || 0;
  const factAllNet = (cash.factNet || 0) + (cash.plannedNet || 0);
  const pct = goalNet ? Math.round(factAllNet / goalNet * 100) : 0;

  const handoffRows = handoffs.filter(item => !['total_chain', 'managed_chain'].includes(item.key)).map(item => {
    // dir:'min' — метрика-запас (чем больше, тем лучше): нарушение, когда
    // значение МЕНЬШЕ норматива; дельту красим в обратную сторону.
    const isMin = item.dir === 'min';
    const over = isMin ? item.medianHours < item.normHours : item.medianHours > item.normHours;
    return `<tr class="${over ? 'p160-over' : ''}">
      <td>${escapeHtml(item.label)}</td>
      <td>${escapeHtml(item.owner)}</td>
      <td class="num"><b>${hoursLabel(item.medianHours)}</b>
        ${deltaHtml(item.medianHours, prevHandoff(item.key), { lessIsBetter: !isMin })}</td>
      <td class="num">${isMin ? '≥ ' : ''}${item.normHours} ч</td>
      <td class="num ${item.overPct > 40 ? 'danger' : ''}">${item.overPct}%</td>
      <td class="num muted">${item.count}</td>
    </tr>`;
  }).join('');

  // Кто ведёт: продуктовые инициативы веду я (Claude) — статус меняется по
  // факту деплоя; организационные — команда. Там, где есть метрика, факт
  // считается из данных и ручная галочка не нужна.
  const sideLabel = item => item.owner_side === 'product'
    ? '<span class="p160-side product" title="Изменение в продукте — статус ведёт Claude">🤖 продукт</span>'
    : '<span class="p160-side team" title="Организационная задача — статус ведёт команда">👥 команда</span>';
  const metricCell = item => {
    if (!item.metric) return '<small class="muted">без метрики</small>';
    const { value, target, unit, reached, label } = item.metric;
    const shown = unit === '₽' ? money(value) : `${value} ${unit}`;
    const goal = unit === '₽' ? money(target) : `${target} ${unit}`;
    return `<span class="p160-metric ${reached === true ? 'ok' : reached === false ? 'bad' : ''}"
      title="${escapeHtml(label)}: считается из данных за период">
      ${shown} <small class="muted">из ${goal}</small></span>`;
  };
  const initiativeRows = initiatives.length ? initiatives.map(item => `<tr>
    <td><b>${escapeHtml(item.title)}</b> ${sideLabel(item)}
      ${item.result ? `<small class="muted" style="display:block">итог: ${escapeHtml(item.result)}</small>` : ''}</td>
    <td>${escapeHtml(item.area || '')}</td>
    <td><small class="muted">${escapeHtml(item.baseline || '')}</small></td>
    <td>${metricCell(item)}</td>
    <td class="num">${item.effect_rub ? money(item.effect_rub) : '—'}</td>
    <td>
      <select data-init-status="${item.id}" class="p160-status">
        ${Object.entries(STATUS).map(([key, label]) =>
    `<option value="${key}" ${item.status === key ? 'selected' : ''}>${label}</option>`).join('')}
      </select>
    </td>
    <td><button class="button ghost small danger" data-init-del="${item.id}">✕</button></td>
  </tr>`).join('') : '<tr><td colspan="7" class="muted">Инициатив пока нет — добавьте первую.</td></tr>';

  const doneEffect = initiatives.filter(item => item.status === 'done')
    .reduce((sum, item) => sum + Number(item.effect_rub || 0), 0);
  const planEffect = initiatives.filter(item => ['todo', 'doing'].includes(item.status))
    .reduce((sum, item) => sum + Number(item.effect_rub || 0), 0);

  // BI-вид (04.11): плитки цели/факта/времени → секции с таблицами .bi-table.
  const pctTone = pct >= 100 ? 'pos' : pct >= 85 ? 'warn' : 'neg';
  const chainTone = (total?.medianHours || 0) > (total?.normHours || 8) ? 'warn' : 'pos';
  const slaTone = operations.questionInSlaPct >= 80 ? 'pos' : 'warn';
  context.showModal(`<div class="p160 bi-page">
    <div class="bi-sub"><h2>🎯 Проект «160 млн» · ${escapeHtml(period.from.slice(0, 7))}</h2>
      <p class="muted">Гипотеза проекта: деньги теряются на времени — на операциях и на передаче
      данных между участниками перевозки. Здесь видно, где стоит время и что дали наши изменения.</p></div>

    <div class="bi-kpis p160-kpis">
      <div class="metric hero dept-staff"><span class="l">Цель месяца</span>
        <span class="v">${goalNet ? money(goalNet) : '— не задана —'}</span>
        <span class="d">без НДС${goalNet ? ` · ${money(Math.round(goalNet * (1 + (cash.vatRate || 0.22))))} с НДС` : ''}</span></div>
      <div class="metric ${pctTone}">
        <span class="l">Факт + в работе</span><span class="v">${money(factAllNet)}</span>
        <span class="d">без НДС · ${pct}% цели · ${cash.trips} рейсов</span></div>
      <div class="metric ${chainTone}">
        <span class="l">Управляемое время заявки</span>
        <span class="v">${hoursLabel(total?.medianHours || 0)}</span>
        <span class="d">от внесения до задания водителю${deltaHtml(total?.medianHours || 0, prevHandoff('managed_chain'))}
          · с ожиданием окна ${hoursLabel(withWait?.medianHours || 0)}</span></div>
      <div class="metric dept-drv ${slaTone}">
        <span class="l">Вопросы водителей</span><span class="v">${operations.questionInSlaPct}<small>%</small></span>
        <span class="d">в норматив 10 мин · медиана ${operations.questionMedianMin} мин</span></div>
      <div class="metric dept-staff"><span class="l">Эффект внедрённого</span>
        <span class="v">${money(doneEffect)}</span><span class="d">сделанные инициативы</span></div>
      <div class="metric"><span class="l">В работе и в очереди</span>
        <span class="v">${money(planEffect)}</span><span class="d">ожидаемый эффект</span></div>
    </div>

    <div class="bi-grid">
    <section class="section">
      <div class="sec-h"><span class="st">Где стоит время между участниками</span>
        <span class="hint">медиана по рейсам месяца</span></div>
      <div class="sec-b"><p class="muted" style="margin:0">Медиана по рейсам месяца. Ожидание планового окна
        погрузки сюда не входит — только то, что зависит от нас. «Запас до подачи» —
        наоборот: чем больше, тем лучше, норматив «не меньше» выучен из факта конвейера.</p></div>
      <div class="sec-b flush bi-scroll"><table class="bi-table p160-table"><thead><tr>
        <th>Передача</th><th>Кто держит</th><th class="num">Медиана</th>
        <th class="num">Норматив</th><th class="num">Вне нормы</th><th class="num">Рейсов</th>
      </tr></thead><tbody>${handoffRows}</tbody></table></div>
    </section>

    <section class="section">
      <div class="sec-h"><span class="st">Сколько действий стоит работа</span></div>
      <div class="sec-b"><div class="bi-kpis">
        <div class="metric"><span class="l">Операций с интервалами ресурса</span>
          <span class="v">${operations.dispositionOps}</span>
          <span class="d">${deltaHtml(operations.dispositionOps, prev?.operations?.dispositionOps, { unit: 'шт' })}</span></div>
        <div class="metric"><span class="l">Отметок этапов на рейс</span>
          <span class="v">${operations.stopFactsPerTrip}</span>
          <span class="d">${deltaHtml(operations.stopFactsPerTrip, prev?.operations?.stopFactsPerTrip, { unit: 'шт' })}</span></div>
        <div class="metric dept-drv"><span class="l">Рейсов выведено на линию</span>
          <span class="v">${operations.trips}</span></div>
        <div class="metric dept-drv"><span class="l">Вопросов водителей</span>
          <span class="v">${operations.questions}</span><span class="d">отвечено ${operations.questionsAnswered}</span></div>
      </div></div>
    </section>

    <section class="section">
      <div class="sec-h"><span class="st">Что меняем в продукте</span>
        <div class="sec-actions p160-effect">
          <span class="bi-tag pos">Эффект внедрённого: <b>${money(doneEffect)}</b></span>
          <span class="bi-tag">В работе и в очереди: <b>${money(planEffect)}</b></span>
        </div></div>
      <div class="sec-b"><p class="muted" style="margin:0">🤖 продукт — веду я, статус меняется по факту
        выката. 👥 команда — ведёте вы. Где есть метрика, «сейчас» считается из данных
        автоматически: зелёная — цель достигнута, красная — ещё нет.</p></div>
      <div class="sec-b flush bi-scroll"><table class="bi-table p160-table"><thead><tr>
        <th>Инициатива</th><th>Область</th><th>Было</th><th>Сейчас / цель</th>
        <th class="num">Эффект, ₽</th><th>Статус</th><th></th>
      </tr></thead><tbody>${initiativeRows}</tbody></table></div>
      <div class="sec-b">
    <form id="p160Add" class="p160-add">
      <input name="title" placeholder="Что улучшаем" required maxlength="200">
      <select name="area">${AREAS.map(area => `<option>${area}</option>`).join('')}</select>
      <input name="baseline" placeholder="было (метрика)" maxlength="160">
      <input name="target" placeholder="цель" maxlength="160">
      <input name="effectRub" type="number" min="0" step="10000" placeholder="эффект, ₽">
      <button class="button small">+ Добавить</button>
    </form>
      </div>
    </section>
    </div>

    <div class="p160-snap">
      <button class="button ghost small" id="p160Snapshot"
        title="Зафиксировать текущие метрики как точку отсчёта — с ней будут сравниваться следующие замеры">📸 Снять замер</button>
      <span class="muted">Замеров сохранено: ${snapshots.length}${snapshots[0]
    ? ` · последний ${String(snapshots[0].created_at).slice(0, 16)}` : ''}</span>
    </div>

    <div class="modal-actions"><button type="button" class="button ghost" data-close>Закрыть</button></div>
  </div>`, 'wide');

  document.getElementById('p160Add').onsubmit = async event => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    try {
      await api('/api/project160/initiatives', { method: 'POST', body: JSON.stringify(values) });
      toast('Инициатива добавлена');
      project160Dialog(context);
    } catch (error) { toast(error.message, 'error'); }
  };
  document.querySelectorAll('[data-init-status]').forEach(select =>
    select.addEventListener('change', async () => {
      const result = select.value === 'done'
        ? prompt('Что получилось? Кратко — это попадёт в историю проекта:', '') : '';
      if (select.value === 'done' && result === null) { project160Dialog(context); return; }
      try {
        await api(`/api/project160/initiatives/${select.dataset.initStatus}`, {
          method: 'PATCH', body: JSON.stringify({ status: select.value, result })
        });
        toast('Статус обновлён');
        project160Dialog(context);
      } catch (error) { toast(error.message, 'error'); }
    }));
  document.querySelectorAll('[data-init-del]').forEach(button =>
    button.addEventListener('click', async () => {
      if (!confirm('Убрать инициативу из проекта?')) return;
      try {
        await api(`/api/project160/initiatives/${button.dataset.initDel}`, { method: 'DELETE' });
        project160Dialog(context);
      } catch (error) { toast(error.message, 'error'); }
    }));
  document.getElementById('p160Snapshot').onclick = async () => {
    const label = prompt('Название замера (например: «до кисти в ресурсе»):', '');
    if (label === null) return;
    try {
      await api('/api/project160/snapshot', { method: 'POST', body: JSON.stringify({ label }) });
      toast('Замер сохранён — следующие метрики будут сравниваться с ним');
      project160Dialog(context);
    } catch (error) { toast(error.message, 'error'); }
  };
}
