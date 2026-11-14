// «Производственный график» — Э2–Э5 (лаборатория prografik-lab,
// конструкция docs/prografik-constr.md). ОДИН экран вместо трёх вкладок:
// строки — геозоны, колонки — дни; сверху сигнальная полоса (дефициты,
// незакрытая сетка, освобождающиеся машины — порог живой, p80 за 35 сут).
// Баланс и матрица считаются ОДНОЙ серверной функцией (/api/prografik, Э3).
// Клик по ячейке — разбор спроса и кандидаты (matchVehicles — та же
// функция, что у продаж и логиста); клик по 🆓 машины — чем занять.
// Решения копятся в черновике «что если» (✏, Э5): баланс пересчитывается
// сразу, «Применить» выполняет пункты ШТАТНЫМИ вызовами (бронь слота —
// «заявка из плана», назначение — /api/orders/:id/assign со щитом причин).
// 📺 ТВ-режим — сигналы и карточки баланса по дням. Старые вкладки живут
// до Э4 (на них плашки-ссылки сюда).
import { api, apiConfirmable, escapeHtml, formatDateTime, money, renderInto,
  captureScrolls, restoreScrolls, attachSearch, toast } from './api.js';
import { bodyTypeCompatible, matchVehicles, resolveAddress } from './sales.js';

const DAY_MS = 86_400_000;
const WD = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const dayLabel = iso => `${WD[new Date(`${iso}T12:00:00Z`).getUTCDay()]} ${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
// Спрос сетки бывает дробным (0,5 машины/день) — до одного знака.
const fmtGap = value => String(Math.round(value * 10) / 10).replace('.', ',');
const shortMoney = value => value >= 1_000_000
  ? `${(value / 1_000_000).toFixed(1).replace('.', ',')} млн`
  : value ? `${Math.round(value / 1000)} т` : '';

// Кэш на минуту: тихий тик не дёргает сеть; черновик и диалоги живут в state.
let cache = { ts: 0, month: '', pg: null };
async function loadData(month, force = false) {
  if (!force && cache.month === month && Date.now() - cache.ts < 60_000) return cache.pg;
  const pg = await api(`/api/prografik?month=${month}`);
  cache = { ts: Date.now(), month, pg };
  return pg;
}
export const invalidatePrografik = () => { cache.ts = 0; };

// ── Черновик «что если» (Э5): локальный список решений пользователя ──
const draftOf = state => state.prografikDraft || (state.prografikDraft = []);
const draftBusy = (state, vehicleId, iso) =>
  draftOf(state).some(item => item.vehicleId === vehicleId && item.day === iso);
const draftClosed = (state, zone, iso) =>
  draftOf(state).filter(item => item.zone === zone && item.day === iso).length;

export async function renderPrografik(container, context) {
  const { state, can } = context;
  const month = state.prografikMonth || new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 7);
  state.prografikMonth = month;
  const horizon = state.prografikHorizon || 'week';
  let pg;
  try { pg = await loadData(month); } catch (error) {
    container.innerHTML = `<div class="muted" style="padding:20px">${escapeHtml(error.message)}</div>`;
    return;
  }
  if (state.view !== 'prografik') return; // ушли с экрана, пока грузилось
  const moneyVisible = (state.data?.user?.access?.money ?? 'full') === 'full';
  const todayIso = pg.todayIso;
  const draft = draftOf(state);

  // Дни горизонта: неделя — от сегодня (в текущем месяце), месяц — весь.
  const todayIdx = Math.max(0, pg.days.indexOf(todayIso));
  const dayIdxs = horizon === 'week'
    ? pg.days.map((_, i) => i).slice(pg.days.includes(todayIso) ? todayIdx : 0).slice(0, 7)
    : pg.days.map((_, i) => i);
  const days = dayIdxs.map(i => pg.days[i]);

  // Ячейка с поправкой черновика: каждый пункт зоны/дня гасит единицу
  // спроса (как в утверждённом прототипе), занятая черновиком машина
  // выбывает из свободных своей зоны.
  const freeDraftCut = (zone, iso) => (pg.freeByDay[iso]?.[zone] || [])
    .filter(index => !draftBusy(state, pg.vehicles[index].id, iso)).length;
  const cellOf = (zone, dayIdx) => {
    const iso = pg.days[dayIdx];
    const raw = pg.cells[zone]?.[dayIdx] || [0, 0, 0, 0, 0, 0];
    return { gap: Math.max(0, raw[0] - draftClosed(state, zone, iso)),
      free: freeDraftCut(zone, iso), income: raw[2],
      planned: raw[3], started: raw[4], unassigned: raw[5] };
  };

  const query = (state.prografikQuery || '').toLowerCase();
  const open = state.prografikOpen || (state.prografikOpen = new Set());
  const focusDay = state.prografikFocus || '';
  const roundOf = vehicleId => (pg.rounds || []).find(round => round.vehicle_id === vehicleId);

  // Фокус-поиск: зона подходит сама, по клиентам её сетки или бортам зоны.
  const zoneMatches = zone => {
    if (!query) return { show: true };
    if (zone.toLowerCase().includes(query)) return { show: true };
    const legs = pg.slots.some(slot => slot.from_name === zone
      && slot.customer_name.toLowerCase().includes(query));
    const orders = pg.orders.some(order => order.from_name === zone
      && order.customer_name.toLowerCase().includes(query));
    const vehs = (pg.freeByDay[days[0]]?.[zone] || []).some(index =>
      `${pg.vehicles[index].plate} ${pg.vehicles[index].driver_name || ''}`.toLowerCase().includes(query));
    return { show: legs || orders || vehs, auto: legs || orders || vehs };
  };

  // ── Задачи: что сделать в ближайшие дни (главный блок экрана) ──
  const draftCut = task => Math.max(0, task.missing - draftClosed(state, task.zone, task.day));
  const liveTasks = (pg.tasks || []).filter(task => draftCut(task) > 0);
  const tasksHtml = liveTasks.length ? `<div class="pg-tasks">
    <div class="pg-tasks-head">❗ Что сделать по ${dayLabel(pg.horizonEnd)} включительно
      <small class="muted">— дальше заявки обычно ещё не внесены (срок выучен по факту), там пусто — это план, не тревога</small></div>
    ${liveTasks.map((task, index) => `<div class="pg-task">
      <b>${dayLabel(task.day)}</b> · ${escapeHtml(task.zone)}:
      не хватает <b class="pg-gap">${draftCut(task)} маш.</b>
      <small class="muted">заявок без машины ${task.unassigned}, свободных в зоне ${task.free}${moneyVisible && task.money ? `, под угрозой ${shortMoney(task.money)} ₽` : ''}</small>
      <button class="button small" data-task="${index}">Разобрать</button>
    </div>`).join('')}</div>`
    : `<div class="pg-tasks pg-tasks-ok">✅ По ${dayLabel(pg.horizonEnd)} включительно машин хватает на весь внесённый спрос${draft.length ? ' (с учётом черновика)' : ''}.</div>`;
  const signalsHtml = (pg.signals || []).map((signal, index) => `
    <button class="pg-sig ${signal.kind}" data-sig="${index}"
      title="${signal.kind === 'grid' ? 'Сфокусировать график на клиенте' : 'Показать день освобождений'}">
      <b>${escapeHtml(signal.title)}</b><span>${escapeHtml(signal.sub)}</span></button>`).join('');

  // ── Сетка ──
  const headRow = `<tr><th class="pg-zone">Зона · состав</th>${days.map(iso =>
    `<th class="${iso === todayIso ? 'pg-today' : ''} ${iso === focusDay ? 'pg-focus' : ''}">${dayLabel(iso)}</th>`).join('')}
    <th title="Выручка зоны за видимый период">Период</th></tr>`;

  const zoneRows = pg.zones
    .map(({ zone }) => ({ zone, match: zoneMatches(zone) }))
    .filter(({ match }) => match.show)
    .map(({ zone, match }) => {
      const cells = dayIdxs.map((dayIdx, column) => {
        const iso = days[column];
        const c = cellOf(zone, dayIdx);
        // Одно главное число на ячейку. Красное «−N» — НЕ ХВАТАЕТ машин
        // (только в горизонте актуальности: дальше заявки ещё не внесены,
        // и пустота там — план, а не пожар). Прошлое — тихий факт.
        const inHorizon = iso >= todayIso && iso <= pg.horizonEnd;
        const past = iso < todayIso;
        let body; let tone = '';
        if (past) {
          body = `<span class="pg-dim">${c.started ? `везли ${c.started}` : '·'}</span>
            ${moneyVisible && c.income ? `<small class="pg-money">${shortMoney(c.income)}</small>` : ''}`;
        } else if (inHorizon && c.gap > c.free) {
          tone = 'pg-bad';
          body = `<b class="pg-lack">−${Math.ceil(c.gap - c.free)} маш.</b>
            <small class="pg-sub">надо ${fmtGap(c.gap)} · есть ${c.free}</small>`;
        } else if (inHorizon && c.gap >= 0.05) {
          tone = 'pg-warn';
          body = `<span>работа ${fmtGap(c.gap)}</span>
            <small class="pg-sub">машин хватает (${c.free})</small>`;
        } else if (inHorizon) {
          body = c.free ? `<span class="pg-free">🚛${c.free} своб.</span>` : '<span class="pg-dim">·</span>';
        } else {
          body = `${c.gap >= 0.05 ? `<span class="pg-dim">план ${fmtGap(c.gap)}</span>` : '<span class="pg-dim">·</span>'}
            ${c.free ? `<small class="pg-sub">🚛${c.free}</small>` : ''}`;
        }
        return `<td class="${tone} ${iso === todayIso ? 'pg-today' : ''} ${iso === focusDay ? 'pg-focus' : ''}">
          <button class="pg-cellbtn" data-cell="${escapeHtml(zone)}|${iso}"
            title="${escapeHtml(zone)} · ${dayLabel(iso)}: спрос без машины ${fmtGap(c.gap)} (сетка ${c.planned}, заявок без ТС ${c.unassigned}), свободно ${c.free}, вышло в рейс ${c.started} — клик: разбор и кандидаты">
            ${body}
          </button></td>`;
      }).join('');
      const periodMoney = dayIdxs.reduce((sum, dayIdx) => sum + (pg.cells[zone]?.[dayIdx]?.[2] || 0), 0);
      const opened = open.has(zone) || match.auto;
      let detail = '';
      if (opened) {
        // Плечи клиентов зоны: план сетки / заявки дня (цвет готовности).
        const legMap = new Map();
        for (const slot of pg.slots.filter(item => item.from_name === zone)) {
          const key = `${slot.customer_name}|${slot.to_name}`;
          if (!legMap.has(key)) legMap.set(key, { customer: slot.customer_name, to: slot.to_name, wd: {} });
          legMap.get(key).wd[slot.weekday] = (legMap.get(key).wd[slot.weekday] || 0) + Number(slot.per_day || 0);
        }
        for (const order of pg.orders.filter(item => item.from_name === zone)) {
          const key = `${order.customer_name}|${order.to_name}`;
          if (!legMap.has(key)) legMap.set(key, { customer: order.customer_name, to: order.to_name, wd: {} });
        }
        const legs = [...legMap.values()].map(leg => {
          let plan = 0; let fact = 0; let revenue = 0;
          for (const iso of days) {
            const weekday = new Date(`${iso}T12:00:00Z`).getUTCDay();
            plan += Math.round(leg.wd[weekday] || 0);
            const factRow = pg.legFacts[`${leg.customer}|${zone}|${leg.to}|${iso}`];
            if (factRow) { fact += factRow[0]; revenue += factRow[2]; }
          }
          return { ...leg, plan, fact, revenue };
        }).filter(leg => leg.plan + leg.fact > 0)
          .sort((a, b) => b.revenue - a.revenue || b.plan - a.plan)
          .filter(leg => !query || leg.customer.toLowerCase().includes(query) || zone.toLowerCase().includes(query));
        const legRows = legs.slice(0, 10).map(leg => {
          const cellsRow = days.map(iso => {
            const weekday = new Date(`${iso}T12:00:00Z`).getUTCDay();
            const plan = Math.round(leg.wd[weekday] || 0);
            const factRow = pg.legFacts[`${leg.customer}|${zone}|${leg.to}|${iso}`] || [0, 0, 0];
            const cls = !plan && !factRow[0] ? '' : factRow[0] >= plan
              ? (factRow[1] >= factRow[0] ? 'pg-ok' : 'pg-part')
              : iso <= todayIso ? 'pg-bad2' : 'pg-warn2';
            const text = !plan && !factRow[0] ? '·' : `${factRow[0]}/${plan || factRow[0]}`;
            return `<td class="${iso === todayIso ? 'pg-today' : ''}"><span class="pg-leg ${cls}"
              title="заявок ${factRow[0]} (с ТС ${factRow[1]}) · план сетки ${plan}">${text}</span></td>`;
          }).join('');
          const segment = pg.segments?.[leg.customer]?.segment;
          return `<tr class="pg-cust"><td class="pg-zone" title="${escapeHtml(leg.customer)} → ${escapeHtml(leg.to)}">
            ↳ ${escapeHtml(leg.customer)}${segment ? ` <span class="badge">${segment}</span>` : ''}
            <small class="muted">→ ${escapeHtml(leg.to)}</small></td>${cellsRow}
            <td>${moneyVisible && leg.revenue ? `<small class="pg-money">${shortMoney(leg.revenue)}</small>` : ''}</td></tr>`;
        }).join('');
        // Машины зоны (позиция на первый видимый день) с полосками занятости.
        const zoneVehIdx = new Set();
        for (const iso of days) for (const index of pg.freeByDay[iso]?.[zone] || []) zoneVehIdx.add(index);
        for (const trip of pg.trips) {
          if (trip.to_name !== zone) continue;
          const index = pg.vehicles.findIndex(vehicle => vehicle.id === trip.vehicle_id);
          if (index >= 0) zoneVehIdx.add(index);
        }
        const vehRows = [...zoneVehIdx]
          .map(index => pg.vehicles[index])
          .filter(vehicle => !query || `${vehicle.plate} ${vehicle.driver_name || ''} ${zone}`.toLowerCase().includes(query))
          .slice(0, 12)
          .map(vehicle => {
            const bars = days.map(iso => {
              const dayStart = Date.parse(`${iso}T00:00:00Z`) - 3 * 3_600_000;
              const draftItem = draft.find(item => item.vehicleId === vehicle.id && item.day === iso);
              if (draftItem) {
                return `<td class="${iso === todayIso ? 'pg-today' : ''}"><span class="pg-bar b-draft"
                  title="Черновик: ${escapeHtml(draftItem.label)}">✏ ${escapeHtml(draftItem.label).slice(0, 14)}</span></td>`;
              }
              const dayTrips = pg.trips.filter(trip => trip.vehicle_id === vehicle.id
                && Date.parse(trip.starts_at) < dayStart + DAY_MS
                && Date.parse(trip.unloaded_at || trip.ends_at) > dayStart);
              const dayDispo = pg.dispositions.filter(item => item.vehicle_id === vehicle.id
                && Date.parse(item.starts_at) < dayStart + DAY_MS && Date.parse(item.ends_at) > dayStart);
              if (!dayTrips.length && !dayDispo.length) {
                return `<td class="${iso === todayIso ? 'pg-today' : ''}"><button class="pg-cellbtn pg-freebtn"
                  data-vfree="${vehicle.id}|${iso}" title="${escapeHtml(vehicle.plate)} свободна ${dayLabel(iso)} — клик: чем занять">🆓</button></td>`;
              }
              const marks = [
                ...dayTrips.map(trip => {
                  const cls = trip.status === 'run' ? 'b-run'
                    : ['unloaded', 'done', 'paid'].includes(trip.status) ? 'b-done' : 'b-plan';
                  return `<span class="pg-bar ${cls}" title="${escapeHtml(trip.customer_name || '')} · ${escapeHtml(trip.from_name)}→${escapeHtml(trip.to_name)} · ${trip.status}">${escapeHtml(trip.from_name)}→${escapeHtml(trip.to_name)}</span>`;
                }),
                ...dayDispo.map(item => {
                  const map = { repair: ['b-repair', '🔧 ремонт'], no_driver: ['b-nodrv', '👤 без водителя'],
                    reserve: ['b-res', '🅿 резерв'], shift: ['b-res', '🔁 пересменка'],
                    out: ['b-res', '⛔'], transfer: ['b-res', '➡ перегон'] }[item.kind] || ['b-res', item.kind];
                  return `<span class="pg-bar ${map[0]}" title="${escapeHtml(item.kind)} до ${formatDateTime(item.ends_at)}">${map[1]}</span>`;
                })
              ].join('');
              return `<td class="${iso === todayIso ? 'pg-today' : ''}">${marks}</td>`;
            }).join('');
            const round = roundOf(vehicle.id);
            return `<tr class="pg-cust pg-vehrow"><td class="pg-zone">
              <span class="mono">${escapeHtml(vehicle.plate)}</span>
              ${round ? `<span class="badge" title="${escapeHtml(round.note || 'круг')}">🎡 ${escapeHtml(String(round.round_key).toUpperCase())}</span>` : ''}
              <small class="muted" style="display:block">${escapeHtml(vehicle.driver_name || 'без водителя')}</small></td>
              ${bars}<td></td></tr>`;
          }).join('');
        const sections = [];
        if (legRows) sections.push(`<tr class="pg-sect"><td class="pg-zone">— спрос: плечи клиентов</td><td colspan="${days.length + 1}"></td></tr>${legRows}`);
        if (vehRows) sections.push(`<tr class="pg-sect"><td class="pg-zone">— ресурс: машины зоны</td><td colspan="${days.length + 1}"></td></tr>${vehRows}`);
        detail = sections.join('');
      }
      return `<tr class="pg-row" data-zone="${escapeHtml(zone)}">
        <td class="pg-zone"><b>${opened ? '▾' : '▸'} ${escapeHtml(zone)}</b></td>${cells}
        <td>${moneyVisible && periodMoney ? `<b class="pg-money">${shortMoney(periodMoney)}</b>` : ''}</td></tr>${detail}`;
    }).join('');

  // Баланс парка по дням (с поправкой черновика) — закреплён внизу.
  const balanceCells = dayIdxs.map((dayIdx, column) => {
    const iso = days[column];
    const [gapRaw, , income] = pg.balance[dayIdx];
    const closed = draft.filter(item => item.day === iso).length;
    const gap = Math.max(0, gapRaw - closed);
    const free = Object.keys(pg.freeByDay[iso] || {})
      .reduce((sum, zone) => sum + freeDraftCut(zone, iso), 0);
    const inHorizon = iso >= todayIso && iso <= pg.horizonEnd;
    const tone = inHorizon && gap > free ? 'pg-bad' : '';
    const label = iso < todayIso ? `<span class="pg-dim">${moneyVisible && income ? shortMoney(income) : '·'}</span>`
      : inHorizon && gap > free ? `<b class="pg-lack">−${Math.ceil(gap - free)} маш.</b>`
        : `<span>${inHorizon ? 'хватает' : 'план'} ${fmtGap(gap)} · 🚛${free}</span>`;
    return `<td class="${tone} ${iso === todayIso ? 'pg-today' : ''}">${label}
      ${iso >= todayIso && moneyVisible && income ? `<small class="pg-money">${shortMoney(income)}</small>` : ''}</td>`;
  }).join('');
  const periodTotal = dayIdxs.reduce((sum, dayIdx) => sum + pg.balance[dayIdx][2], 0);
  const balanceRow = `<tr class="pg-balance"><td class="pg-zone"><b>Баланс парка</b>
    <small class="muted">спрос▲ · свободно · ₽</small></td>${balanceCells}
    <td>${moneyVisible ? `<b>${shortMoney(periodTotal)}</b>` : ''}</td></tr>`;

  // ── Черновик (панель) ──
  const canApply = can('trips:write') || can('orders:write');
  const draftPanel = draft.length ? `<div class="pg-draft">
    <b>✏ Черновик решений: ${draft.length}</b> — баланс выше уже пересчитан, в планер пока не записано
    ${draft.map((item, index) => `<div class="pg-draft-item">• ${dayLabel(item.day)}:
      ${item.plate ? `<b class="mono">${escapeHtml(item.plate)}</b> → ` : ''}${escapeHtml(item.label)}
      <a href="#" data-undo="${index}">убрать</a></div>`).join('')}
    <div style="margin-top:6px">
      ${canApply ? '<button class="button small" id="pgApply">Применить — создать назначения</button>' : '<span class="muted">применить может логист или продажи (права записи)</span>'}
      <button class="button ghost small" id="pgDraftClear">Сбросить</button>
    </div></div>` : '';

  // ── ТВ-режим ──
  const tvHtml = state.prografikTv ? (() => {
    const tvIdxs = pg.days.map((_, i) => i).slice(pg.days.includes(todayIso) ? todayIdx : 0).slice(0, 7);
    return `<div class="pg-tv" id="pgTvOverlay">
      <div class="pg-tv-head"><b>▦ Производственный график</b>
        <span>${dayLabel(todayIso)} · обновляется автоматически</span>
        <button class="button ghost" id="pgTvExit">✕ выйти</button></div>
      <div class="pg-tv-sig">${(pg.signals || []).slice(0, 5).map(signal =>
    `<div class="pg-sig ${signal.kind}"><b>${escapeHtml(signal.title)}</b><span>${escapeHtml(signal.sub)}</span></div>`).join('')
    || '<div class="pg-sig good"><b>Баланс ✓</b><span>дефицитов не видно</span></div>'}</div>
      <div class="pg-tv-cards">${tvIdxs.map(dayIdx => {
    const iso = pg.days[dayIdx];
    const [gap, free, income] = pg.balance[dayIdx];
    const deficit = Math.ceil(gap - free);
    const inHorizon = iso <= pg.horizonEnd;
    const n = inHorizon && deficit > 0 ? `−${deficit} маш.` : inHorizon ? 'машин хватает' : `план ${fmtGap(gap)}`;
    return `<div class="pg-tv-card ${iso === todayIso ? 'now' : ''}">
          <div class="d">${dayLabel(iso)}</div>
          <div class="n ${inHorizon && deficit > 0 ? 'bad' : inHorizon ? 'ok' : ''}">${n}</div>
          <div class="s">спрос ${fmtGap(gap)} · свободно ${free}${moneyVisible && income ? `<br>${shortMoney(income)}` : ''}</div>
        </div>`;
  }).join('')}</div></div>`;
  })() : '';

  const savedScrolls = captureScrolls(container);
  const html = `<div class="bi-page pg-page">
    ${tasksHtml}
    ${signalsHtml ? `<div class="pg-signals">${signalsHtml}</div>` : ''}
    <div class="bi-kpis bi-kpis-row">
      <div class="segmented" id="pgMonthNav">
        <button data-m="-1" title="Предыдущий месяц">‹</button>
        <button disabled style="min-width:84px">${month.slice(5, 7)}.${month.slice(0, 4)}</button>
        <button data-m="1" title="Следующий месяц">›</button>
      </div>
      <div class="segmented" id="pgHorizon">
        <button data-h="week" class="${horizon === 'week' ? 'active' : ''}">Неделя</button>
        <button data-h="month" class="${horizon === 'month' ? 'active' : ''}">Месяц</button>
      </div>
      <input id="pgSearch" class="block-search" placeholder="Поиск: зона, клиент, борт" value="${escapeHtml(state.prografikQuery || '')}">
      <button class="button ghost" id="pgTvBtn" title="Крупные карточки баланса для табло">📺 Табло</button>
      <button class="button ghost" id="pgLegend" title="Что значат цвета и числа">ⓘ Как читать</button>
    </div>
    <section class="section"><div class="sec-b pg-wrap">
      <table class="pg-table"><thead>${headRow}</thead>
        <tbody>${zoneRows || '<tr><td class="muted" style="padding:14px">Нет данных за период</td></tr>'}</tbody>
        <tfoot>${balanceRow}</tfoot></table>
    </div></section>
    ${draftPanel}${tvHtml}</div>`;
  if (!renderInto(container, html)) { restoreScrolls(container, savedScrolls); return; }
  restoreScrolls(container, savedScrolls);

  const rerender = () => renderPrografik(container, context);

  // ── Проводка ──
  container.querySelector('#pgMonthNav').onclick = event => {
    const button = event.target.closest('[data-m]');
    if (!button) return;
    const base = new Date(Date.parse(`${month}-01T12:00:00Z`));
    base.setUTCMonth(base.getUTCMonth() + Number(button.dataset.m));
    state.prografikMonth = base.toISOString().slice(0, 7);
    state.prografikFocus = '';
    rerender();
  };
  container.querySelector('#pgHorizon').onclick = event => {
    const button = event.target.closest('[data-h]');
    if (!button) return;
    state.prografikHorizon = button.dataset.h;
    rerender();
  };
  attachSearch(container.querySelector('#pgSearch'), value => {
    state.prografikQuery = value;
    return rerender();
  });
  container.querySelector('#pgTvBtn').onclick = () => { state.prografikTv = true; rerender(); };
  container.querySelectorAll('[data-task]').forEach(button => button.onclick = () => {
    const task = liveTasks[Number(button.dataset.task)];
    if (task) zoneDayDialog(task.zone, task.day, pg, context, rerender);
  });
  container.querySelector('#pgLegend')?.addEventListener('click', () => context.showModal(
    `<div class="sales-modal pg-modal"><h2>ⓘ Как читать график</h2>
      <p><b>Верхний блок «Что сделать»</b> — готовый список: где и в какой день
      не хватает машин. Кнопка «Разобрать» открывает этот день с кандидатами.</p>
      <p><b>Сетка.</b> Строка — зона погрузки (по выручке), колонка — день.</p>
      <p>🔴 <b>−3 маш.</b> — в этот день в зоне не хватает трёх машин на внесённый
      спрос. Это пожар — кликните и закройте кандидатами.</p>
      <p>🟡 <b>работа 5</b> — спрос есть, свободных машин хватает: осталось
      назначить (клик — кандидаты).</p>
      <p><b>🚛4 своб.</b> — работы нет, машины простаивают: клик по зоне покажет,
      чем их занять.</p>
      <p><span class="pg-dim">план 6</span> серым — день дальше «${pg.norms?.horizon?.value || 2} дн.»:
      туда заявки обычно ещё не внесены (срок система выучила по факту),
      это ожидаемая сетка, не тревога.</p>
      <p><b>Клик по названию зоны</b> — состав: плечи клиентов «заявки/план»
      (🟢 внесено и назначено · 🟡 внесено, нет машины · 🔴 день настал, заявок
      меньше плана) и машины зоны по дням (рейс, 🔧 ремонт, 👤 без водителя,
      🆓 свободна — клик подскажет, чем занять).</p>
      <p><b>✏ Черновик</b>: кнопки ✏ копят решения в панель снизу — баланс
      пересчитывается сразу, в планер ничего не уходит. «Применить» создаёт
      заявки и назначения по-настоящему и показывает отчёт по каждому пункту.</p>
      <div class="modal-actions"><button class="button" data-close>Понятно</button></div></div>`));
  container.querySelector('#pgTvExit')?.addEventListener('click', () => { state.prografikTv = false; rerender(); });
  container.querySelectorAll('.pg-sig[data-sig]').forEach(element => element.onclick = () => {
    const signal = pg.signals[Number(element.dataset.sig)];
    if (!signal) return;
    if (signal.kind === 'grid') { state.prografikQuery = signal.customer; }
    else {
      state.prografikFocus = signal.day;
      if (horizon === 'week' && !days.includes(signal.day)) state.prografikHorizon = 'month';
    }
    rerender();
  });
  container.querySelectorAll('tr.pg-row .pg-zone').forEach(cell => cell.addEventListener('click', () => {
    const zone = cell.closest('tr').dataset.zone;
    if (open.has(zone)) open.delete(zone); else open.add(zone);
    rerender();
  }));
  container.querySelectorAll('[data-cell]').forEach(button => button.addEventListener('click', event => {
    event.stopPropagation();
    const [zone, iso] = button.dataset.cell.split('|');
    zoneDayDialog(zone, iso, pg, context, rerender);
  }));
  container.querySelectorAll('[data-vfree]').forEach(button => button.addEventListener('click', event => {
    event.stopPropagation();
    const [vehicleId, iso] = button.dataset.vfree.split('|');
    vehicleDayDialog(vehicleId, iso, pg, context, rerender);
  }));
  container.querySelectorAll('[data-undo]').forEach(link => link.addEventListener('click', event => {
    event.preventDefault();
    draft.splice(Number(link.dataset.undo), 1);
    rerender();
  }));
  container.querySelector('#pgDraftClear')?.addEventListener('click', () => { draft.length = 0; rerender(); });
  container.querySelector('#pgApply')?.addEventListener('click', () => applyDraft(pg, context, rerender));
}

// Кандидаты на заявку/день — тот же matchVehicles, что у продаж и логиста
// (живые нормативы: подгон plannedKmBetween, готовность живым транзитом),
// плюс фильтр совместимости кузова и занятость черновиком.
function candidatesFor(state, pg, fromName, windowFrom, order = null) {
  const data = state.data;
  const fromAddress = order?.from_address_id
    ? (data.reference.addresses || []).find(item => item.id === order.from_address_id)
    : resolveAddress(data, order?.from_point || fromName);
  return matchVehicles(data, fromName, windowFrom, fromAddress, order?.from_point || '')
    .filter(candidate => !order || bodyTypeCompatible(data, order.body_type, candidate.vehicle.type_name))
    .filter(candidate => !draftBusy(state, candidate.vehicle.id, String(windowFrom).slice(0, 10)))
    .slice(0, 6);
}

function candidateRow(candidate, pg, action) {
  const round = (pg.rounds || []).find(item => item.vehicle_id === candidate.vehicle.id);
  return `<div class="pg-cand"><span style="flex:1;min-width:0">
    <b class="mono">${escapeHtml(candidate.vehicle.plate)}</b>
    <small class="muted"> · ${escapeHtml(candidate.vehicle.type_name || '')}
      · ${escapeHtml(candidate.vehicle.driver_name || 'без водителя')}${candidate.emptyKm != null ? ` · подгон ~${candidate.emptyKm} км${candidate.approx ? ' (по зоне)' : ''}` : ''}${candidate.readyAt ? ` · ${candidate.ready ? 'готова с' : '⚠ готова только с'} ${formatDateTime(candidate.readyAt)}` : ''}</small>
    ${round ? `<span class="badge">🎡 ${escapeHtml(String(round.round_key).toUpperCase())}</span>` : ''}
    ${candidate.stillRunning ? '<small class="pg-warn2"> · 🛣 ещё в рейсе, освобождение расчётное</small>' : ''}
    <span class="badge ${candidate.inZone ? 'ok' : 'warn'}">${candidate.inZone ? 'в зоне' : escapeHtml(candidate.region || candidate.zoneName || 'перегон')}</span>
  </span>${action}</div>`;
}

// ── Диалог ячейки: разбор спроса зоны за день + решения (Э2) ──
function zoneDayDialog(zone, iso, pg, context, rerender) {
  const { state, can, showModal, closeModal } = context;
  const draft = draftOf(state);
  const weekday = new Date(`${iso}T12:00:00Z`).getUTCDay();
  const mskDayOf = value => new Date(Date.parse(value) + 3 * 3_600_000).toISOString().slice(0, 10);
  const dayOrders = pg.orders.filter(order => order.from_name === zone && mskDayOf(order.window_from) === iso
    && !draft.some(item => item.orderId === order.id));
  // Дыры сетки: план слота минус заявки дня минус брони в черновике.
  const gaps = pg.slots.filter(slot => slot.from_name === zone && slot.weekday === weekday)
    .map(slot => {
      const fact = pg.legFacts[`${slot.customer_name}|${zone}|${slot.to_name}|${iso}`] || [0];
      const booked = draft.filter(item => item.kind === 'book' && item.day === iso
        && item.customer === slot.customer_name && item.toName === slot.to_name).length;
      return { ...slot, miss: Math.round(slot.per_day) - fact[0] - booked };
    }).filter(slot => slot.miss > 0);
  const freeIdx = (pg.freeByDay[iso]?.[zone] || [])
    .filter(index => !draftBusy(state, pg.vehicles[index].id, iso));
  const windowDefault = new Date(Date.parse(iso) + 5 * 3_600_000).toISOString(); // 08:00 МСК

  const ordersHtml = dayOrders.map(order => `<div class="pg-item">
    <div><b>№ ${escapeHtml(String(order.order_no || '—'))}</b> ${escapeHtml(order.customer_name)}
      · ${escapeHtml(order.from_name)}→${escapeHtml(order.to_name)}
      <small class="muted">· окно ${formatDateTime(order.window_from)}${order.body_type ? ` · ${escapeHtml(order.body_type)}` : ''}${Number(order.rate_vat) ? ` · ${money(order.rate_vat)}` : ''}</small>
      <button class="button ghost small" data-cands="${order.id}">Кандидаты ▾</button></div>
    <div class="pg-cands" id="cands-${order.id}" hidden></div></div>`).join('')
    || '<p class="muted">Заявок без машины на этот день в зоне нет.</p>';

  const gapsHtml = gaps.length ? gaps.map((slot, index) => `<div class="pg-item">
    <div>▦ ${escapeHtml(slot.customer_name)} · ${escapeHtml(zone)}→${escapeHtml(slot.to_name)}
      <small class="muted">· не закрыто ${slot.miss} · ставка сетки ${money(slot.rate || 0)}</small>
      ${can('orders:write') ? `<button class="button ghost small" data-book="${index}">✏ Заявка в черновик</button>
      <button class="button ghost small" data-bookveh="${index}">✏ С машиной ▾</button>` : '<small class="muted">бронируют продажи</small>'}
    </div><div class="pg-cands" id="bookcands-${index}" hidden></div></div>`).join('')
    : '<p class="muted">Сетка этого дня закрыта заявками.</p>';

  showModal(`<div class="sales-modal pg-modal"><h2>${escapeHtml(zone)} · ${dayLabel(iso)}</h2>
    <p class="muted">Заявок без ТС ${dayOrders.length} · дыр сетки ${gaps.reduce((sum, slot) => sum + slot.miss, 0)}
      · свободно в зоне ${freeIdx.length} · в черновике по ячейке ${draftClosed(state, zone, iso)}</p>
    <h3>Спрос без машины</h3>${ordersHtml}
    <h3>Сетка без заявок</h3>${gapsHtml}
    <h3>Свободные машины зоны</h3>
    <div>${freeIdx.map(index => `<button class="button ghost small" data-vopen="${pg.vehicles[index].id}"
      title="${escapeHtml(pg.vehicles[index].driver_name || 'без водителя')} — чем занять">🆓 ${escapeHtml(pg.vehicles[index].plate)}</button>`).join(' ')
    || '<span class="muted">свободных нет — смотрите кандидатов у заявок (перегон из соседних зон)</span>'}</div>
    <div class="modal-actions"><button class="button ghost" data-close>Закрыть</button></div></div>`);

  // Кандидаты на заявку: ✏ в черновик / назначить сразу.
  document.querySelectorAll('[data-cands]').forEach(button => button.onclick = () => {
    const order = dayOrders.find(item => item.id === button.dataset.cands);
    const box = document.getElementById(`cands-${order.id}`);
    if (!box.hidden) { box.hidden = true; return; }
    const candidates = candidatesFor(state, pg, zone, order.window_from, order);
    box.innerHTML = candidates.map((candidate, index) => candidateRow(candidate, pg,
      `<span style="white-space:nowrap"><button class="button ghost small" data-draft="${order.id}|${index}">✏</button>
      ${can('trips:write') ? `<button class="button small" data-now="${order.id}|${index}">Назначить</button>` : ''}</span>`)).join('')
      || '<p class="muted">Свободных совместимых машин к окну нет — двигать окно или перегонять.</p>';
    box.hidden = false;
    box.querySelectorAll('[data-draft]').forEach(element => element.onclick = () => {
      const candidate = candidates[Number(element.dataset.draft.split('|')[1])];
      draft.push({ kind: 'assign', day: iso, zone, orderId: order.id, orderNo: order.order_no,
        vehicleId: candidate.vehicle.id, plate: candidate.vehicle.plate,
        label: `${order.customer_name} ${zone}→${order.to_name}` });
      closeModal(); rerender();
    });
    box.querySelectorAll('[data-now]').forEach(element => element.onclick = async () => {
      const candidate = candidates[Number(element.dataset.now.split('|')[1])];
      try {
        await api(`/api/orders/${order.id}/assign`, { method: 'POST',
          body: JSON.stringify({ vehicleId: candidate.vehicle.id, autoConfirm: true }) });
        toast(`${candidate.vehicle.plate} назначена — рейс у диспетчера`);
        closeModal(); invalidatePrografik(); await context.onReload();
      } catch (error) { toast(error.message, 'error'); }
    });
  });
  // Дыра сетки: бронь (заявка из плана) без машины или сразу с машиной.
  document.querySelectorAll('[data-book]').forEach(button => button.onclick = () => {
    const slot = gaps[Number(button.dataset.book)];
    draft.push({ kind: 'book', day: iso, zone, customer: slot.customer_name,
      fromZoneId: slot.from_zone_id, toZoneId: slot.to_zone_id, toName: slot.to_name,
      rate: slot.rate || 0, label: `бронь ${slot.customer_name} ${zone}→${slot.to_name}` });
    closeModal(); rerender();
  });
  document.querySelectorAll('[data-bookveh]').forEach(button => button.onclick = () => {
    const slot = gaps[Number(button.dataset.bookveh)];
    const box = document.getElementById(`bookcands-${button.dataset.bookveh}`);
    if (!box.hidden) { box.hidden = true; return; }
    // Кузов и пункт — из последней заявки плеча: совместимость кандидатов
    // проверяется как у настоящей заявки (тушевозный груз — только тушевозу).
    const last = pg.lastPoints[`${slot.customer_name}|${slot.from_zone_id}|${slot.to_zone_id}`] || {};
    const candidates = candidatesFor(state, pg, zone, windowDefault,
      { body_type: last.bodyType || '', from_point: last.fromPoint || '' });
    box.innerHTML = candidates.map((candidate, index) => candidateRow(candidate, pg,
      `<button class="button ghost small" data-bookdraft="${index}">✏ бронь + машина</button>`)).join('')
      || '<p class="muted">Свободных машин нет.</p>';
    box.hidden = false;
    box.querySelectorAll('[data-bookdraft]').forEach(element => element.onclick = () => {
      const candidate = candidates[Number(element.dataset.bookdraft)];
      draft.push({ kind: 'book', day: iso, zone, customer: slot.customer_name,
        fromZoneId: slot.from_zone_id, toZoneId: slot.to_zone_id, toName: slot.to_name,
        rate: slot.rate || 0, vehicleId: candidate.vehicle.id, plate: candidate.vehicle.plate,
        label: `бронь ${slot.customer_name} ${zone}→${slot.to_name}` });
      closeModal(); rerender();
    });
  });
  document.querySelectorAll('[data-vopen]').forEach(button => button.onclick = () => {
    closeModal();
    vehicleDayDialog(button.dataset.vopen, iso, pg, context, rerender);
  });
}

// ── Диалог свободной машины: чем занять (Э2) ──
function vehicleDayDialog(vehicleId, iso, pg, context, rerender) {
  const { state, can, showModal, closeModal } = context;
  const draft = draftOf(state);
  const vehicle = pg.vehicles.find(item => item.id === vehicleId);
  if (!vehicle) return;
  const zone = Object.entries(pg.freeByDay[iso] || {})
    .find(([, list]) => list.some(index => pg.vehicles[index].id === vehicleId))?.[0] || vehicle.zone_name || '';
  const mskDayOf = value => new Date(Date.parse(value) + 3 * 3_600_000).toISOString().slice(0, 10);
  const weekday = new Date(`${iso}T12:00:00Z`).getUTCDay();
  // Работа дня: заявки без ТС (своя зона первой, дальше по деньгам) и дыры сетки зоны.
  const work = pg.orders
    .filter(order => mskDayOf(order.window_from) === iso && !draft.some(item => item.orderId === order.id))
    .filter(order => bodyTypeCompatible(state.data, order.body_type, vehicle.type_name))
    .sort((a, b) => Number(b.from_name === zone) - Number(a.from_name === zone)
      || Number(b.rate_vat || 0) - Number(a.rate_vat || 0))
    .slice(0, 8);
  const gaps = pg.slots.filter(slot => slot.from_name === zone && slot.weekday === weekday)
    .map(slot => {
      const fact = pg.legFacts[`${slot.customer_name}|${zone}|${slot.to_name}|${iso}`] || [0];
      const booked = draft.filter(item => item.kind === 'book' && item.day === iso
        && item.customer === slot.customer_name && item.toName === slot.to_name).length;
      return { ...slot, miss: Math.round(slot.per_day) - fact[0] - booked };
    }).filter(slot => slot.miss > 0).slice(0, 4);
  const round = (pg.rounds || []).find(item => item.vehicle_id === vehicleId);

  showModal(`<div class="sales-modal pg-modal"><h2>🆓 ${escapeHtml(vehicle.plate)} · ${dayLabel(iso)}</h2>
    <p class="muted">${escapeHtml(vehicle.driver_name || 'без водителя')} · ${escapeHtml(vehicle.type_name || '')}
      ${zone ? ` · позиция: ${escapeHtml(zone)}` : ' · зона не ясна'}
      ${round ? ` · 🎡 круг ${escapeHtml(String(round.round_key).toUpperCase())}` : ''}</p>
    <h3>Чем занять (заявки без ТС)</h3>
    ${work.map((order, index) => `<div class="pg-item"><div>
      <b>№ ${escapeHtml(String(order.order_no || '—'))}</b> ${escapeHtml(order.customer_name)}
      · ${escapeHtml(order.from_name)}→${escapeHtml(order.to_name)}
      <small class="muted">· ${formatDateTime(order.window_from)}${Number(order.rate_vat) ? ` · ${money(order.rate_vat)}` : ''}${order.from_name !== zone ? ` · ⚠ перегон из ${escapeHtml(zone || '—')}` : ''}</small>
      <span style="white-space:nowrap"><button class="button ghost small" data-wdraft="${index}">✏</button>
      ${can('trips:write') ? `<button class="button small" data-wnow="${index}">Назначить</button>` : ''}</span>
    </div></div>`).join('') || '<p class="muted">Открытых заявок на день нет.</p>'}
    <h3>Сетка зоны без заявок</h3>
    ${gaps.map((slot, index) => `<div class="pg-item"><div>▦ ${escapeHtml(slot.customer_name)}
      · ${escapeHtml(zone)}→${escapeHtml(slot.to_name)}
      <small class="muted">· не закрыто ${slot.miss} · ставка ${money(slot.rate || 0)}</small>
      ${can('orders:write') ? `<button class="button ghost small" data-gdraft="${index}">✏ бронь + эта машина</button>` : ''}
    </div></div>`).join('') || '<p class="muted">Дыр сетки в зоне нет — машина кандидат на перегон в дефицитную зону (см. сигналы).</p>'}
    <div class="modal-actions"><button class="button ghost" data-close>Закрыть</button></div></div>`);

  document.querySelectorAll('[data-wdraft]').forEach(button => button.onclick = () => {
    const order = work[Number(button.dataset.wdraft)];
    draft.push({ kind: 'assign', day: iso, zone: order.from_name, orderId: order.id,
      orderNo: order.order_no, vehicleId, plate: vehicle.plate,
      label: `${order.customer_name} ${order.from_name}→${order.to_name}` });
    closeModal(); rerender();
  });
  document.querySelectorAll('[data-wnow]').forEach(button => button.onclick = async () => {
    const order = work[Number(button.dataset.wnow)];
    try {
      await api(`/api/orders/${order.id}/assign`, { method: 'POST',
        body: JSON.stringify({ vehicleId, autoConfirm: true }) });
      toast(`${vehicle.plate} назначена — рейс у диспетчера`);
      closeModal(); invalidatePrografik(); await context.onReload();
    } catch (error) { toast(error.message, 'error'); }
  });
  document.querySelectorAll('[data-gdraft]').forEach(button => button.onclick = () => {
    const slot = gaps[Number(button.dataset.gdraft)];
    draft.push({ kind: 'book', day: iso, zone, customer: slot.customer_name,
      fromZoneId: slot.from_zone_id, toZoneId: slot.to_zone_id, toName: slot.to_name,
      rate: slot.rate || 0, vehicleId, plate: vehicle.plate,
      label: `бронь ${slot.customer_name} ${zone}→${slot.to_name}` });
    closeModal(); rerender();
  });
}

// ── «Применить» черновика (Э5): пункты выполняются штатными вызовами ──
// последовательно, отчёт ✓/✗ по каждому. Бронь — «заявка из плана»
// (окно 08–20 МСК, пункты последней заявки плеча), назначение — обычный
// assign (щит причин замены рекомендации отвечает 422 — пункт краснеет,
// решение остаётся за человеком в обычном диалоге).
async function applyDraft(pg, context, rerender) {
  const { state, showModal } = context;
  const draft = draftOf(state);
  if (!draft.length) return;
  const items = [...draft];
  const results = [];
  for (const item of items) {
    try {
      let orderId = item.orderId;
      if (item.kind === 'book') {
        const last = pg.lastPoints[`${item.customer}|${item.fromZoneId}|${item.toZoneId}`] || {};
        const created = await apiConfirmable('/api/orders', 'POST', {
          customerName: item.customer,
          fromZoneId: item.fromZoneId, toZoneId: item.toZoneId,
          fromPoint: last.fromPoint || '', toPoint: last.toPoint || '',
          fromAddressId: last.fromAddressId || null, toAddressId: last.toAddressId || null,
          windowFrom: new Date(Date.parse(item.day) + 5 * 3_600_000).toISOString(),
          windowTo: new Date(Date.parse(item.day) + 17 * 3_600_000).toISOString(),
          rateVat: Number(item.rate) || 0,
          temperatureMode: last.temperatureMode || '', bodyType: last.bodyType || '',
          comment: 'Из производственного графика (черновик решений)'
        });
        orderId = created.id;
        results.push({ item, ok: true, note: `заявка № ${created.orderNo} создана` });
      }
      if (item.vehicleId && orderId) {
        await api(`/api/orders/${orderId}/assign`, { method: 'POST',
          body: JSON.stringify({ vehicleId: item.vehicleId, autoConfirm: true }) });
        results.push({ item, ok: true, note: `${item.plate} назначена` });
      } else if (item.kind === 'assign' && !item.vehicleId) {
        results.push({ item, ok: false, note: 'нет машины в пункте' });
      }
      draft.splice(draft.indexOf(item), 1);
    } catch (error) {
      results.push({ item, ok: false, note: error.message });
    }
  }
  invalidatePrografik();
  await context.onReload();
  showModal(`<div class="sales-modal pg-modal"><h2>Черновик применён</h2>
    ${results.map(result => `<div class="pg-item"><div>${result.ok ? '✅' : '❌'}
      ${dayLabel(result.item.day)} · ${escapeHtml(result.item.label)}
      <small class="${result.ok ? 'muted' : 'pg-warn2'}">· ${escapeHtml(result.note)}</small></div></div>`).join('')}
    ${draft.length ? `<p class="muted">Не прошло пунктов: ${draft.length} — они остались в черновике, поправьте и повторите.</p>` : ''}
    <div class="modal-actions"><button class="button" data-close>Понятно</button></div></div>`);
  rerender();
}
