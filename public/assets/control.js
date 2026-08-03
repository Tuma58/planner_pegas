// Контроль выполнения рейса — рабочее место диспетчера по образцу
// «Транспортировок» корпоративных TMS: стоянки рейса с плановым, расчётным и
// фактическим временем прибытия/отправления и окнами грузовых работ.
// Факты двигают конвейер: отправление с погрузки → «В пути», прибытие и
// завершение работ на конечной → «Выгружен» (стадия заявки меняется на сервере).
import { api, escapeHtml, formValues, formatDateTime, routeLabel, toLocalInput, toast } from './api.js';
import { waitingLabel } from './pipeline.js';

const KIND_LABELS = { P: 'Погрузка', D: 'Выгрузка' };
// Порядок вех на стоянке — следующая пустая и есть текущее действие диспетчера.
const MILESTONES = [
  ['actual_arrival', 'Прибыл', 'actualArrival'],
  ['work_started_at', 'Начало работ', 'workStartedAt'],
  ['work_finished_at', 'Окончание работ', 'workFinishedAt'],
  ['actual_departure', 'Убыл', 'actualDeparture']
];

const FILTERS = [
  ['all', 'Все'], ['run', 'В пути'], ['plan', 'План'],
  ['delayed', 'С опозданием'], ['finished', 'Выполнены']
];

const time = value => value ? formatDateTime(value) : '—';

function delayBadge(trip) {
  if (['unloaded', 'done', 'paid'].includes(trip.status)) {
    return trip.delay_ms > 30 * 60_000
      ? `<span class="badge warn">выполнен, опоздание ${waitingLabel(trip.delay_ms)}</span>`
      : '<span class="badge ok">выполнен вовремя</span>';
  }
  if (trip.delay_ms > 30 * 60_000) {
    return `<span class="badge bad">опоздание ${waitingLabel(trip.delay_ms)}</span>`;
  }
  return '<span class="badge ok">в графике</span>';
}

// Следующее незакрытое действие по рейсу: первая стоянка с пустой вехой.
function nextMilestone(trip) {
  for (const stop of trip.stops) {
    for (const [column, label, field] of MILESTONES) {
      if (!stop[column]) return { stopId: stop.id, column, label, field, point: stop.point };
    }
  }
  return null;
}

function stopRow(stop, trip, canAct, next) {
  const est = stop.estimated_arrival;
  const late = est && stop.planned_arrival &&
    Date.parse(est) - Date.parse(stop.planned_arrival) > 30 * 60_000;
  const actionCell = canAct && next && next.stopId === stop.id
    ? `<button class="button small" data-milestone="${stop.id}" data-field="${next.field}"
        title="Проставить факт «${next.label}» текущим временем">${next.label}</button>`
    : '';
  return `<tr>
    <td class="muted">${stop.seq}</td>
    <td>${KIND_LABELS[stop.kind] || stop.kind}</td>
    <td><strong>${escapeHtml(stop.point)}</strong>${stop.note
      ? `<small class="muted" style="display:block">${escapeHtml(stop.note)}</small>` : ''}</td>
    <td>${time(stop.planned_arrival)}</td>
    <td style="${late ? 'color:var(--bad);font-weight:700' : ''}">${stop.actual_arrival ? '—' : time(est)}</td>
    <td>${time(stop.actual_arrival)}</td>
    <td>${time(stop.planned_departure)}</td>
    <td>${time(stop.actual_departure)}</td>
    <td>${time(stop.work_started_at)}</td>
    <td>${time(stop.work_finished_at)}</td>
    <td class="num">${Number(stop.distance_km) ? `${Math.round(stop.distance_km)} км` : '—'}</td>
    <td class="num">${actionCell}
      ${canAct ? `<button class="button ghost small" data-edit-stop="${stop.id}" data-trip="${trip.id}"
        title="Изменить времена и данные стоянки">✎</button>` : ''}</td>
  </tr>`;
}

function tripCard(trip, context, expanded) {
  const canAct = context.can('trip-status:write');
  const next = nextMilestone(trip);
  const statusMeta = (context.state.data.settings.statuses || [])
    .find(([code]) => code === trip.status);
  return `<div class="card" style="margin-bottom:10px">
    <div class="list-item" data-toggle-trip="${trip.id}" style="cursor:pointer">
      <span style="flex:1;min-width:0">
        <strong>${escapeHtml(routeLabel(trip))}</strong>
        <small class="muted" style="display:block">
          <span class="mono">${escapeHtml(trip.vehicle_plate)}</span>
          · ${escapeHtml(trip.driver_name || 'без водителя')} · ${escapeHtml(trip.customer_name)}
          · ${formatDateTime(trip.starts_at)} → ${formatDateTime(trip.ends_at)}</small>
      </span>
      ${statusMeta ? `<span class="badge" style="background:${statusMeta[2]};color:#fff">${statusMeta[1]}</span>` : ''}
      ${delayBadge(trip)}
      ${canAct && next ? `<span class="pipe-badge mine" title="Следующее действие диспетчера">→ ${next.label}: ${escapeHtml(next.point)}</span>` : ''}
      <span class="muted">${expanded ? '▾' : '▸'}</span>
    </div>
    ${expanded ? `<div style="overflow-x:auto"><table class="rtable"><thead><tr>
        <th>№</th><th>Тип</th><th>Пункт</th>
        <th>План прибытие</th><th>Расчёт прибытие</th><th>Факт прибытие</th>
        <th>План отправление</th><th>Факт отправление</th>
        <th>Начало работ</th><th>Окончание работ</th><th class="num">Плечо</th><th></th>
      </tr></thead><tbody>${trip.stops.map(stop => stopRow(stop, trip, canAct, next)).join('')}</tbody></table></div>
      ${canAct ? `<div style="margin-top:6px"><button class="button ghost small" data-add-stop="${trip.id}">+ Промежуточная стоянка</button></div>` : ''}`
    : ''}
  </div>`;
}

function editStopDialog(stop, trip, context, refresh) {
  context.showModal(`<h2>Стоянка ${stop.seq} · ${KIND_LABELS[stop.kind] || ''} · ${escapeHtml(stop.point)}</h2>
    <p class="muted">${escapeHtml(routeLabel(trip))} · <span class="mono">${escapeHtml(trip.vehicle_plate)}</span></p>
    <form id="stopForm" class="form-grid">
      <label>Пункт<input name="point" value="${escapeHtml(stop.point)}" required></label>
      <label>Плечо от предыдущей, км<input type="number" min="0" name="distanceKm" value="${Number(stop.distance_km) || 0}"></label>
      <label>План прибытие<input type="datetime-local" name="plannedArrival" value="${toLocalInput(stop.planned_arrival) || ''}"></label>
      <label>План отправление<input type="datetime-local" name="plannedDeparture" value="${toLocalInput(stop.planned_departure) || ''}"></label>
      <label>Факт прибытие<input type="datetime-local" name="actualArrival" value="${toLocalInput(stop.actual_arrival) || ''}"></label>
      <label>Факт отправление<input type="datetime-local" name="actualDeparture" value="${toLocalInput(stop.actual_departure) || ''}"></label>
      <label>Начало работ<input type="datetime-local" name="workStartedAt" value="${toLocalInput(stop.work_started_at) || ''}"></label>
      <label>Окончание работ<input type="datetime-local" name="workFinishedAt" value="${toLocalInput(stop.work_finished_at) || ''}"></label>
      <label style="grid-column:1/-1">Примечание<input name="note" value="${escapeHtml(stop.note || '')}"></label>
      <div class="modal-actions" style="grid-column:1/-1">
        ${trip.stops.length > 2 ? `<button type="button" class="button ghost danger" id="stopDelete">Удалить стоянку</button>` : ''}
        <button type="button" class="button ghost" data-close>Отмена</button>
        <button class="button" type="submit">Сохранить</button>
      </div>
    </form>`);
  document.getElementById('stopForm').onsubmit = async event => {
    event.preventDefault();
    try {
      const values = formValues(event.target);
      // Пустые времена — явный сброс факта (null), а не «не менять».
      for (const key of ['plannedArrival', 'plannedDeparture', 'actualArrival',
        'actualDeparture', 'workStartedAt', 'workFinishedAt']) {
        if (!values[key]) values[key] = null;
      }
      const result = await api(`/api/stops/${stop.id}`, { method: 'PATCH', body: JSON.stringify(values) });
      context.closeModal();
      toast('Стоянка обновлена');
      await refresh(Boolean(result.tripStatus));
    } catch (error) { toast(error.message, 'error'); }
  };
  const remove = document.getElementById('stopDelete');
  if (remove) remove.onclick = async () => {
    try {
      await api(`/api/stops/${stop.id}`, { method: 'DELETE' });
      context.closeModal();
      toast('Стоянка удалена');
      await refresh(false);
    } catch (error) { toast(error.message, 'error'); }
  };
}

function addStopDialog(trip, context, refresh) {
  context.showModal(`<h2>Промежуточная стоянка</h2>
    <p class="muted">${escapeHtml(routeLabel(trip))} · <span class="mono">${escapeHtml(trip.vehicle_plate)}</span></p>
    <form id="addStopForm" class="form-grid">
      <label>Пункт<input name="point" required placeholder="Например, Рязань"></label>
      <label>Тип<select name="kind"><option value="D">Выгрузка</option><option value="P">Погрузка</option></select></label>
      <label>План прибытие<input type="datetime-local" name="plannedArrival"></label>
      <label>План отправление<input type="datetime-local" name="plannedDeparture"></label>
      <label>Плечо от предыдущей, км<input type="number" min="0" name="distanceKm" value="0"></label>
      <label>Примечание<input name="note"></label>
      <div class="modal-actions" style="grid-column:1/-1">
        <button type="button" class="button ghost" data-close>Отмена</button>
        <button class="button" type="submit">Добавить</button>
      </div>
    </form>`);
  document.getElementById('addStopForm').onsubmit = async event => {
    event.preventDefault();
    try {
      await api(`/api/trips/${trip.id}/stops`, {
        method: 'POST', body: JSON.stringify(formValues(event.target))
      });
      context.closeModal();
      toast('Стоянка добавлена');
      await refresh(false);
    } catch (error) { toast(error.message, 'error'); }
  };
}

export async function renderControl(container, context) {
  const { state } = context;
  state.controlFilter ||= 'all';
  state.controlExpanded ||= new Set();
  container.innerHTML = '<div class="empty-state">Загрузка контроля рейсов…</div>';
  let items;
  try {
    ({ items } = await api('/api/control'));
  } catch (error) {
    container.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    return;
  }

  const finished = trip => ['unloaded', 'done', 'paid'].includes(trip.status);
  const matches = trip => ({
    all: true,
    run: trip.status === 'run',
    plan: trip.status === 'plan',
    delayed: trip.delay_ms > 30 * 60_000 && !finished(trip),
    finished: finished(trip)
  })[state.controlFilter];
  const visible = items.filter(matches);
  // Проблемные сверху: идущие с опозданием, затем по началу рейса.
  visible.sort((a, b) => (Number(finished(a)) - Number(finished(b))) ||
    (b.delay_ms - a.delay_ms) || a.starts_at.localeCompare(b.starts_at));

  const counts = Object.fromEntries(FILTERS.map(([key]) => [key,
    items.filter(trip => ({
      all: true, run: trip.status === 'run', plan: trip.status === 'plan',
      delayed: trip.delay_ms > 30 * 60_000 && !finished(trip), finished: finished(trip)
    })[key]).length]));

  // Автораскрытие: если фильтр сузил список до нескольких рейсов — раскрываем.
  if (visible.length <= 3) visible.forEach(trip => state.controlExpanded.add(trip.id));

  container.innerHTML = `<div class="salesfilter">
      <strong>Контроль выполнения рейсов</strong>
      ${FILTERS.map(([key, label]) => `<button class="button ghost small ${state.controlFilter === key ? 'active' : ''}"
        data-control-filter="${key}">${label} (${counts[key]})</button>`).join('')}
      <span class="muted" style="margin-left:auto">окно: вчера — послезавтра · факты двигают конвейер заявки</span>
    </div>
    ${visible.map(trip => tripCard(trip, context, state.controlExpanded.has(trip.id))).join('')
      || '<div class="empty-state">Рейсов в оперативном окне нет.</div>'}`;

  const refresh = async statusChanged => {
    // Смена статуса рейса затрагивает Гант/Продажи — обновляем весь bootstrap.
    if (statusChanged) await context.onReload();
    else await renderControl(container, context);
  };

  container.querySelectorAll('[data-control-filter]').forEach(button =>
    button.addEventListener('click', () => {
      state.controlFilter = button.dataset.controlFilter;
      renderControl(container, context);
    }));
  container.querySelectorAll('[data-toggle-trip]').forEach(row =>
    row.addEventListener('click', event => {
      if (event.target.closest('button')) return;
      const id = row.dataset.toggleTrip;
      state.controlExpanded.has(id) ? state.controlExpanded.delete(id) : state.controlExpanded.add(id);
      renderControl(container, context);
    }));
  container.querySelectorAll('[data-milestone]').forEach(button =>
    button.addEventListener('click', async () => {
      try {
        const result = await api(`/api/stops/${button.dataset.milestone}`, {
          method: 'PATCH', body: JSON.stringify({ [button.dataset.field]: new Date().toISOString() })
        });
        toast(result.tripStatus === 'run' ? 'Рейс отправлен в путь'
          : result.tripStatus === 'unloaded' ? 'Рейс выгружен — конвейер передан бухгалтерии'
            : 'Факт отмечен');
        await refresh(Boolean(result.tripStatus));
      } catch (error) { toast(error.message, 'error'); }
    }));
  container.querySelectorAll('[data-edit-stop]').forEach(button =>
    button.addEventListener('click', () => {
      const trip = items.find(item => item.id === button.dataset.trip);
      const stop = trip?.stops.find(item => item.id === button.dataset.editStop);
      if (stop) editStopDialog(stop, trip, context, refresh);
    }));
  container.querySelectorAll('[data-add-stop]').forEach(button =>
    button.addEventListener('click', () => {
      const trip = items.find(item => item.id === button.dataset.addStop);
      if (trip) addStopDialog(trip, context, refresh);
    }));
}
