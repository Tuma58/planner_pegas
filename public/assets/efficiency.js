// «Повышение эффективности»: презентация за период внутри вкладки
// «Руководитель → Неделя/Месяц». Данные — /api/efficiency (канон),
// выпуски — /api/efficiency/issues (автосборка пт 08:00 и месяц),
// план недели редактируется и сверяется «обещано → сделано».
import { api, escapeHtml, renderInto, toast } from './api.js';

const mln = value => (Number(value || 0) / 1e6).toFixed(value >= 99.5e6 ? 0 : 2).replace('.', ',');
const num = value => Number(value || 0).toLocaleString('ru-RU');
const dd = iso => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
const lastDay = toExclusive => dd(new Date(Date.parse(toExclusive) - 864e5).toISOString().slice(0, 10));

function delta(cur, base, { invert = false, pp = false, pct = true } = {}) {
  if (base == null || cur == null || !base) return '';
  const diff = pp ? cur - base : (cur - base) / Math.abs(base) * 100;
  if (!Number.isFinite(diff) || Math.abs(diff) < 0.05) return '<span class="d flat">=</span>';
  const good = invert ? diff < 0 : diff > 0;
  const arrow = diff > 0 ? '▲' : '▼';
  const text = pp ? `${diff > 0 ? '+' : ''}${diff.toFixed(1)} пп`
    : pct ? `${diff > 0 ? '+' : ''}${diff.toFixed(1)}%` : '';
  return `<span class="d ${good ? 'up' : 'down'}">${arrow} ${text}</span>`;
}

export async function renderEfficiency(container, context, { issueId = null } = {}) {
  const { state } = context;
  let issue = null;
  let data;
  let from; let to;
  try {
    if (issueId) {
      issue = await api(`/api/efficiency/issues/${issueId}`);
      data = { ...issue.data, from: issue.periodStart, to: issue.periodEnd };
      from = issue.periodStart; to = issue.periodEnd;
    } else {
      const today = new Date().toISOString().slice(0, 10);
      to = state.effTo || today;
      from = state.effFrom || new Date(Date.parse(to) - 7 * 864e5).toISOString().slice(0, 10);
      data = await api(`/api/efficiency?from=${from}&to=${to}&base=${state.effBase || 'samePrevMonth'}`);
    }
  } catch (error) {
    container.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    return;
  }
  const P = data.period;
  const B = data.base;
  const S = data.service || {};
  const issues = state.effIssues || (state.effIssues = (await api('/api/efficiency/issues').catch(() => ({ items: [] }))).items);

  // Плитка BI-набора: подпись .l, цифра .v, дельта к базе .d (delta() уже
  // отдаёт <span class="d up|down|flat">), пояснение — мелкой строкой.
  const kpi = (value, deltaHtml, label, cls = '', title = '') => `<div class="metric kpi ${cls}"${title ? ` title="${escapeHtml(title)}"` : ''}>
    <span class="l">${title || label}</span><span class="v">${value}</span>${deltaHtml || ''}<span class="eff-note">${label}</span></div>`;
  const weShare = P.weekdayAvg ? Math.round(P.weekendAvg / P.weekdayAvg * 100) : null;
  const weShareB = B?.weekdayAvg ? Math.round(B.weekendAvg / B.weekdayAvg * 100) : null;

  const downKinds = [['no_driver', 'Без водителя', true], ['repair', 'Ремонт', true],
    ['shift', 'Пересменка', true], ['transfer', 'Перегоны', false]];
  const maxDown = Math.max(1, ...downKinds.map(([k]) => Math.max(P.downtime[k] || 0, B?.downtime?.[k] || 0)));

  const planItems = issue ? issue.plan : (state.effDraftPlan || []);
  const review = issue?.review;

  const html = `<div class="effwrap bi-page">
    <div class="period bi-sub"><div class="bi-actions eff-period">
      <b>Период:</b>
      ${issue ? `<span class="pill good">выпуск · ${issue.kind === 'week' ? 'неделя' : issue.kind === 'month' ? 'месяц' : 'период'}
          ${dd(from)}–${lastDay(to)}</span>
        <button class="button ghost small" id="effLive">⟳ живой расчёт</button>`
    : `<input type="date" id="effFrom" value="${from}">—<input type="date" id="effTo" value="${to}">
      <select id="effBase">
        <option value="samePrevMonth" ${state.effBase !== 'prev' ? 'selected' : ''}>к тому же отрезку прошлого месяца</option>
        <option value="prev" ${state.effBase === 'prev' ? 'selected' : ''}>к предыдущему периоду встык</option>
      </select>
      <button class="button small" id="effGo">⟳ Сформировать</button>
      <button class="button ghost small" id="effSave" title="Зафиксировать выпуск с текущим планом">💾 В выпуски</button>`}
      <select id="effIssues" style="margin-left:auto">
        <option value="">— выпуски (${issues.length}) —</option>
        ${issues.map(item => `<option value="${item.id}" ${issue?.id === item.id ? 'selected' : ''}>
          ${item.kind === 'week' ? '📊' : item.kind === 'month' ? '📅' : '🗂'} ${dd(item.period_start)}–${lastDay(item.period_end)}</option>`).join('')}
      </select>
      <button class="button ghost small" id="effPrint">🖨</button>
    </div></div>

    ${review?.plan?.length ? `<div class="eff-review">
      <b>Сверка прошлой недели (${dd(review.periodStart)}–${lastDay(review.periodEnd)}):</b>
      ${review.plan.map(item => `<span class="pill ${item.done ? 'good' : 'bad'}" title="${escapeHtml(item.metric || '')}">${item.done ? '✓' : '✗'} ${escapeHtml(item.title)}</span>`).join(' ')}
    </div>` : ''}

    <div class="kicker">Эффективность · ${dd(from)}–${lastDay(to)}${B ? ` · база ${dd(data.baseFrom || B.from)}–${lastDay(data.baseTo || B.to)}` : ''}</div>
    <div class="bi-kpis eff-kpis">
      ${kpi(`${num(P.revPerVd)}<small>₽</small>`, delta(P.revPerVd, B?.revPerVd), `на машино-день парка${B ? ` (база: ${num(B.revPerVd)})` : ''} — главная цифра`, 'hero dept-staff', '₽ на машино-день')}
      ${kpi(`${mln(P.rev)}<small>млн</small>`, delta(P.rev, B?.rev), `выручка бНДС за ${P.days} дн${B ? ` (база: ${mln(B.rev)})` : ''}`, 'dept-staff', 'Выручка бНДС')}
      ${kpi(P.koef != null ? `${P.koef}<small>%</small>` : '—', delta(P.koef, B?.koef, { pp: true }), `КТГ ${P.ktg ?? '—'} × КВЛ ${P.kvl ?? '—'} × КИП ${P.kip ?? '—'}`, 'dept-staff', 'КОЭФ')}
      ${kpi(`${P.ktg ?? '—'}<small>%</small>`, delta(P.ktg, B?.ktg, { pp: true }), `техготовность${B ? ` (база: ${B.ktg ?? '—'}%)` : ''}`, 'dept-toir', 'КТГ')}
      ${kpi(`${P.kvl ?? '—'}<small>%</small>`, delta(P.kvl, B?.kvl, { pp: true }), `выход на линию${B ? ` (база: ${B.kvl ?? '—'}%)` : ''}`, 'dept-drv', 'КВЛ')}
      ${kpi(`${P.kip ?? '—'}<small>%</small>`, delta(P.kip, B?.kip, { pp: true }), `работа экипажа, от потолка${B ? ` (база: ${B.kip ?? '—'}%)` : ''}`, 'dept-log', 'КИП')}
      ${kpi(`${num(P.downtime.no_driver || 0)}<small>м-д</small>`, delta(P.downtime.no_driver || 0, B?.downtime?.no_driver, { invert: true }), 'простой «без водителя» за период', (P.downtime.no_driver || 0) > 0 ? 'warn' : '', 'Без водителя')}
      ${kpi(weShare != null ? `${weShare}<small>%</small>` : '—', delta(weShare, weShareB, { pp: true }), `выходной к буднему: ${mln(P.weekendAvg)}/${mln(P.weekdayAvg)} млн`, '', 'Выходной к буднему')}
      ${kpi(`${num(P.avgCheck)}<small>₽</small>`, delta(P.avgCheck, B?.avgCheck), `средний чек · ₽/км ${P.rubKm}`, '', 'Средний чек')}
    </div>

    <div class="bi-grid">
    <section class="section s6 eff-slide dept-staff">
      <div class="sec-h"><span class="st">Деньги</span><span class="hint">период · база · Δ</span></div>
      <div class="sec-b flush">
      <table class="bi-table rtable"><thead><tr><th></th><th class="num">период</th><th class="num">база</th><th class="num">Δ</th></tr></thead><tbody>
        <tr><td>Выручка бНДС, млн</td><td class="num"><b>${mln(P.rev)}</b></td><td class="num">${B ? mln(B.rev) : '—'}</td><td class="num">${delta(P.rev, B?.rev)}</td></tr>
        <tr><td>₽ / машино-день</td><td class="num"><b>${num(P.revPerVd)}</b></td><td class="num">${B ? num(B.revPerVd) : '—'}</td><td class="num">${delta(P.revPerVd, B?.revPerVd)}</td></tr>
        <tr><td>Рейсов</td><td class="num"><b>${num(P.trips)}</b></td><td class="num">${B ? num(B.trips) : '—'}</td><td class="num">${delta(P.trips, B?.trips)}</td></tr>
        <tr><td>Средний чек, ₽</td><td class="num"><b>${num(P.avgCheck)}</b></td><td class="num">${B ? num(B.avgCheck) : '—'}</td><td class="num">${delta(P.avgCheck, B?.avgCheck)}</td></tr>
        <tr><td>Будний день, млн</td><td class="num"><b>${mln(P.weekdayAvg)}</b></td><td class="num">${B ? mln(B.weekdayAvg) : '—'}</td><td class="num">${delta(P.weekdayAvg, B?.weekdayAvg)}</td></tr>
        <tr><td>Выходной день, млн</td><td class="num"><b>${mln(P.weekendAvg)}</b></td><td class="num">${B ? mln(B.weekendAvg) : '—'}</td><td class="num">${delta(P.weekendAvg, B?.weekendAvg)}</td></tr>
        <tr><td>₽ / км</td><td class="num"><b>${P.rubKm}</b></td><td class="num">${B ? B.rubKm : '—'}</td><td class="num">${delta(P.rubKm, B?.rubKm)}</td></tr>
      </tbody></table>
      </div>
    </section>

    <section class="section s6 eff-slide dept-toir">
      <div class="sec-h"><span class="st">Парк</span><span class="hint">КТГ · КВЛ · КИП · простои, м-д</span></div>
      <div class="sec-b flush">
      <table class="bi-table rtable"><thead><tr><th></th><th class="num">период</th><th class="num">база</th><th class="num">Δ</th></tr></thead><tbody>
        <tr><td>КТГ — техготовность</td><td class="num"><b>${P.ktg ?? '—'}%</b></td><td class="num">${B?.ktg ?? '—'}%</td><td class="num">${delta(P.ktg, B?.ktg, { pp: true })}</td></tr>
        <tr><td>КВЛ — выход на линию</td><td class="num"><b>${P.kvl ?? '—'}%</b></td><td class="num">${B?.kvl ?? '—'}%</td><td class="num">${delta(P.kvl, B?.kvl, { pp: true })}</td></tr>
        <tr><td>КИП — работа экипажа <small class="muted">(от потолка)</small></td><td class="num"><b>${P.kip ?? '—'}%</b></td><td class="num">${B?.kip ?? '—'}%</td><td class="num">${delta(P.kip, B?.kip, { pp: true })}</td></tr>
        ${P.restDayAvg != null ? `<tr><td>Отдых/стояния в пути <small class="muted">(маш среднесуточно)</small></td><td class="num"><b>${P.restDayAvg}</b></td><td class="num">${B?.restDayAvg ?? '—'}</td><td class="num">${delta(P.restDayAvg, B?.restDayAvg, { pp: true, invert: true })}</td></tr>` : ''}
      </tbody></table>
      <div class="sec-b eff-down">
        ${downKinds.map(([key, label, invert]) => `<div class="bar"><span class="lbl">${label}</span>
          <div class="bi-meter ${invert ? 'warn' : ''}"><i style="width:${Math.round((P.downtime[key] || 0) / maxDown * 100)}%"></i></div>
          <span class="val"><b>${P.downtime[key] || 0}</b>${B ? ` ← ${B.downtime?.[key] || 0}` : ''} ${delta(P.downtime[key] || 0, B?.downtime?.[key], { invert })}</span></div>`).join('')}
      </div>
      </div>
    </section>

    <section class="section s7 eff-slide dept-drv">
      <div class="sec-h"><span class="st">Люди и сервис</span></div>
      <div class="sec-b flush">
      ${data.board ? `<table class="bi-table rtable"><thead><tr><th>🗂 Доска диспетчерской</th><th class="num">период</th><th class="num">база</th><th class="num">Δ</th></tr></thead><tbody>
        <tr><td>Подготовка: подтверждён → на линию, ч</td><td class="num"><b>${data.board.leadPrepH ?? '—'}</b></td><td class="num">${data.boardBase?.leadPrepH ?? '—'}</td><td class="num">${delta(data.board.leadPrepH, data.boardBase?.leadPrepH, { invert: true })}</td></tr>
        <tr><td>Погрузка: на линии → убыл, ч</td><td class="num"><b>${data.board.leadLoadH ?? '—'}</b></td><td class="num">${data.boardBase?.leadLoadH ?? '—'}</td><td class="num">${delta(data.board.leadLoadH, data.boardBase?.leadLoadH, { invert: true })}</td></tr>
        <tr><td>В пути: убыл → прибыл, ч</td><td class="num"><b>${data.board.leadRoadH ?? '—'}</b></td><td class="num">${data.boardBase?.leadRoadH ?? '—'}</td><td class="num">${delta(data.board.leadRoadH, data.boardBase?.leadRoadH, { invert: true })}</td></tr>
        <tr><td>Выгрузка: прибыл → выгружен, ч</td><td class="num"><b>${data.board.leadUnloadH ?? '—'}</b></td><td class="num">${data.boardBase?.leadUnloadH ?? '—'}</td><td class="num">${delta(data.board.leadUnloadH, data.boardBase?.leadUnloadH, { invert: true })}</td></tr>
        <tr><td>Отметки в реальный момент (≤30 мин)</td><td class="num"><b>${data.board.realtimeSharePct ?? '—'}%</b></td><td class="num">${data.boardBase?.realtimeSharePct ?? '—'}%</td><td class="num">${delta(data.board.realtimeSharePct, data.boardBase?.realtimeSharePct, { pp: true })}</td></tr>
        <tr><td>«Выгружен» позже убытия 12+ ч</td><td class="num"><b>${data.board.lateClose12 ?? '—'}</b></td><td class="num">${data.boardBase?.lateClose12 ?? '—'}</td><td class="num">${delta(data.board.lateClose12, data.boardBase?.lateClose12, { invert: true })}</td></tr>
        <tr><td>Контроль: отметок/день · людей</td><td class="num"><b>${data.board.ctrlMarksPerDay ?? 0} · ${data.board.ctrlPeople ?? 0}</b></td><td class="num">${data.boardBase ? `${data.boardBase.ctrlMarksPerDay} · ${data.boardBase.ctrlPeople}` : '—'}</td><td class="num"></td></tr>
      </tbody></table>
      ${data.board.shiftCapacity ? `<p class="muted" style="margin:4px 0 10px">Ёмкость смены (выучена из факта, видна только здесь и руководителю): ${Object.entries(data.board.shiftCapacity.caps || {}).map(([n, c]) => `${escapeHtml(n.split(' ').slice(0, 2).join(' '))} — ${c}`).join(' · ') || '—'} · фолбэк ${data.board.shiftCapacity.fallback}</p>` : ''}
      ${data.board.hero ? `<p style="margin:4px 0 6px"><b>🏆 Герой недели:</b> ${escapeHtml(data.board.hero.name)} — ${data.board.hero.marks} отметок контроля за ${data.board.hero.days} дн, лучшая плотность к личной норме (${data.board.hero.cap}/день)</p>` : ''}
      ${data.board.deadTail?.cards?.length ? `<p style="margin:4px 0 10px"><b>💀 Мёртвый хвост (${data.board.deadTail.cards.length} карточек дольше ${data.board.deadTail.days} суток без движения)</b> — выведены из эскалаций, зачищаются постановкой забытых фактов:<br>
        <span class="muted">${data.board.deadTail.cards.slice(0, 12).map(c => `${escapeHtml(c.plate || '?')} — ${c.idleDays} дн`).join(' · ')}${data.board.deadTail.cards.length > 12 ? ` · … ещё ${data.board.deadTail.cards.length - 12}` : ''}</span></p>` : ''}` : ''}
      <table class="bi-table rtable"><tbody>
        <tr><td>Адресность карточек звонка</td><td class="num"><b>${S.inTotal ? Math.round(S.inAddressed / S.inTotal * 100) + '%' : '—'}</b></td><td class="muted">цель > 60% · входящих ${num(S.inTotal || 0)}</td></tr>
        <tr><td>Перезвон по пропущенным, медиана</td><td class="num"><b>${S.callbackMedianMin ?? '—'} мин</b></td><td class="muted">норматив 10 мин</td></tr>
        <tr><td>Пропущенные → вопросы</td><td class="num"><b>${S.missedQuestions || 0}</b></td><td class="muted">закрыто ${S.missedClosed || 0}</td></tr>
      </tbody></table>
      </div>
    </section>

    <section class="section s5 eff-slide dept-log">
      <div class="sec-h"><span class="st">Клиенты · топ периода</span><span class="hint">млн бНДС</span></div>
      <div class="sec-b flush">
      <table class="bi-table rtable"><thead><tr><th>Клиент</th><th class="num">период</th><th class="num">база</th><th class="num">Δ</th></tr></thead><tbody>
        ${P.clients.slice(0, 6).map(client => {
    const baseClient = B?.clients?.find(item => item.name === client.name);
    return `<tr><td>${escapeHtml(client.name)}</td><td class="num"><b>${mln(client.rev)}</b></td>
      <td class="num">${baseClient ? mln(baseClient.rev) : '—'}</td>
      <td class="num">${delta(client.rev, baseClient?.rev)}</td></tr>`;
  }).join('')}
      </tbody></table>
      </div>
    </section>

    ${data.initiatives?.length ? `<section class="section eff-slide">
      <div class="sec-h"><span class="st">Инициативы периода</span></div>
      <div class="sec-b flush">
      <table class="bi-table rtable"><tbody>${data.initiatives.map(item => `<tr>
        <td>${escapeHtml(item.title)}</td><td>${escapeHtml(item.result || item.target || '')}</td>
        <td><span class="pill ${item.status === 'done' ? 'good' : 'warn'}">${item.status === 'done' ? 'сделано' : 'в работе'}</span></td>
      </tr>`).join('')}</tbody></table>
      </div>
    </section>` : ''}

    <section class="section eff-slide">
      <div class="sec-h"><span class="st">План следующей недели</span><span class="hint">задача · целевая метрика · ответственный</span></div>
      <div class="sec-b">
      <div id="effPlanList">${planItems.map((item, index) => `<div class="eff-plan-row" data-idx="${index}">
        <label><input type="checkbox" data-plan-done="${index}" ${item.done ? 'checked' : ''}></label>
        <div><b>${escapeHtml(item.title)}</b><div class="muted" style="font-size:12.5px">${escapeHtml(item.metric || '')}${item.owner ? ` · ${escapeHtml(item.owner)}` : ''}</div></div>
        <button class="button ghost small" data-plan-del="${index}">✕</button>
      </div>`).join('') || '<p class="muted">Пунктов пока нет — добавьте первый.</p>'}</div>
      <form id="effPlanAdd" class="eff-plan-add">
        <input name="title" placeholder="Задача" required style="flex:2">
        <input name="metric" placeholder="Целевая метрика" style="flex:2">
        <input name="owner" placeholder="Ответственный" style="flex:1">
        <button class="button small">＋</button>
      </form>
      </div>
    </section>
    </div>
  </div>`;
  if (!renderInto(container, html)) return;

  const persistPlan = async nextPlan => {
    if (issue) {
      await api(`/api/efficiency/issues/${issue.id}/plan`, { method: 'PATCH',
        body: JSON.stringify({ plan: nextPlan }) }).catch(error => toast(error.message));
      issue.plan = nextPlan;
    } else {
      state.effDraftPlan = nextPlan;
    }
    renderEfficiency(container, context, { issueId: issue?.id || null });
  };
  container.querySelector('#effPlanAdd').addEventListener('submit', event => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    persistPlan([...planItems, { title: values.get('title'), metric: values.get('metric'),
      owner: values.get('owner'), done: false }]);
  });
  container.querySelectorAll('[data-plan-del]').forEach(button =>
    button.onclick = () => persistPlan(planItems.filter((_, index) => index !== Number(button.dataset.planDel))));
  container.querySelectorAll('[data-plan-done]').forEach(box =>
    box.onchange = () => persistPlan(planItems.map((item, index) =>
      index === Number(box.dataset.planDone) ? { ...item, done: box.checked } : item)));

  container.querySelector('#effIssues').onchange = event => {
    const id = event.target.value;
    renderEfficiency(container, context, { issueId: id || null });
  };
  container.querySelector('#effPrint').onclick = () => window.print();
  const live = container.querySelector('#effLive');
  if (live) live.onclick = () => renderEfficiency(container, context, {});
  const go = container.querySelector('#effGo');
  if (go) {
    go.onclick = () => {
      state.effFrom = container.querySelector('#effFrom').value;
      state.effTo = container.querySelector('#effTo').value;
      state.effBase = container.querySelector('#effBase').value;
      renderEfficiency(container, context, {});
    };
    container.querySelector('#effSave').onclick = async () => {
      try {
        const saved = await api('/api/efficiency/issues', { method: 'POST', body: JSON.stringify({
          kind: 'custom', from, to, plan: planItems }) });
        state.effIssues = null;
        toast('Выпуск зафиксирован');
        renderEfficiency(container, context, { issueId: saved.id });
      } catch (error) { toast(error.message); }
    };
  }
}
