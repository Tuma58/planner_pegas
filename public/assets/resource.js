// Диспетчерская доска ресурса — гант по аналогии с главным планером:
// строки ТС с рейсами (тонкие полосы) и интервалами недоступности (цветные бары),
// плашки-счётчики состояний, справа — панель заданий сотрудника.
import { api, attachSearch, escapeHtml, formatDateTime, formValues, fromLocalInput, toast, wireSelectSearch } from './api.js';

export const DISP_KINDS = [
  { kind: 'work', label: 'В работе', short: 'работа', color: 'var(--teal)' },
  { kind: 'reserve', label: 'Резерв', short: 'резерв', color: '#5a9e54' },
  { kind: 'repair', label: 'В ремонте', short: 'ремонт', color: '#bd8f42' },
  { kind: 'no_driver', label: 'Без водителя', short: 'без вод.', color: '#b06a55' },
  { kind: 'shift', label: 'Пересменка', short: 'пересм.', color: '#5e87ad' },
  { kind: 'idle', label: 'Без заказа', short: 'без заказа', color: '#8a7fb3' },
  { kind: 'out', label: 'Выведен', short: 'выведен', color: '#8f9aa6' }
];

const kindMeta = kind => DISP_KINDS.find(item => item.kind === kind) || DISP_KINDS[0];

// Вахта водителя: рабочий ли день и до какого числа длится текущий период.
// Схема «on дней работы / off отдыха» от даты начала рабочего периода.
export function shiftStateAt(driver, dayIso) {
  const on = Number(driver?.shift_on);
  const off = Number(driver?.shift_off);
  if (!on || !off || !driver.shift_anchor) return null;
  const cycle = on + off;
  const dayMs = Date.parse(`${String(dayIso).slice(0, 10)}T00:00:00Z`);
  const diff = Math.floor((dayMs - Date.parse(`${String(driver.shift_anchor).slice(0, 10)}T00:00:00Z`)) / 86_400_000);
  const position = ((diff % cycle) + cycle) % cycle;
  const rest = position >= on;
  const periodEndMs = dayMs + ((rest ? cycle : on) - position - 1) * 86_400_000;
  return { rest, until: new Date(periodEndMs).toISOString().slice(0, 10) };
}

// График работы водителей: две проекции — «водители × дни: какое ТС» и
// «ТС × дни: какой водитель». Закрепления из истории аудита + текущего
// справочника; поверх — пересменки/«без водителя»/ремонт (диспозиции),
// отсутствия из карточки водителя и факт явки (✓/✗ с причиной).
// ── График работы водителей: основной вид вкладки «Ресурс» ──
// Две проекции (ТС × дни → водитель; водители × дни → ТС) с рейсами фоном,
// периодными закреплениями, вахтами, диспозициями и явкой.
const shortName = full => {
  const parts = String(full || '').split(/\s+/);
  return `${parts[0] || ''}${parts[1] ? ` ${parts[1][0]}.` : ''}`;
};

// Периодное закрепление, покрывающее момент дня, — приоритетнее постоянного.
const plannedAt = (planned, midMs, key, id) => (planned || []).filter(item =>
  item[key] === id && Date.parse(item.starts_at) <= midMs && Date.parse(item.ends_at) > midMs);

function buildScheduleTable({ payload, data, view, startIso, days: DAYS,
  query = '', filterKind = null, refDay = null, canWrite = false }) {
  const { assignments, planned, attendance, dispositions } = payload;
  // Режим фильтрации: на экране остаются только подходящие строки.
  // Поиск — по номеру, прицепу, ФИО; плашка-состояние — по состоянию
  // сцепки на выбранный день (у водителя — состояние его машины).
  const day0 = refDay || startIso;
  const needle = String(query || '').toLowerCase();
  const kindOf = vehicle => vehicle ? vehicleStateAt(vehicle, data, day0).kind : 'no_driver';
  const vehicleById = new Map(payload.vehicles.map(vehicle => [vehicle.id, vehicle]));
  const vehicles = payload.vehicles.filter(vehicle => {
    if (filterKind && kindOf(vehicle) !== filterKind) return false;
    return !needle || `${vehicle.plate} ${vehicle.trailer_plate || ''} ${vehicle.driver_name || ''}`
      .toLowerCase().includes(needle);
  });
  const drivers = payload.drivers.filter(driver => {
    const vehicle = driver.vehicle_id ? vehicleById.get(driver.vehicle_id) : null;
    if (filterKind && kindOf(vehicle) !== filterKind) return false;
    return !needle || `${driver.full_name} ${vehicle?.plate || ''} ${vehicle?.trailer_plate || ''}`
      .toLowerCase().includes(needle);
  });
  const plateOf = new Map(payload.vehicles.map(vehicle => [vehicle.id, vehicle.plate]));
  const driverById = new Map(payload.drivers.map(driver => [driver.id, driver]));
  const attByDriver = new Map(attendance.map(item => [`${item.driver_id}|${item.day}`, item]));
  const days = Array.from({ length: DAYS }, (_, index) =>
    new Date(Date.parse(`${startIso}T00:00:00Z`) + index * 86_400_000));
  const todayIso = new Date().toISOString().slice(0, 10);
  const trips = (data.trips || []).filter(trip => trip.status !== 'rejected');
  const tripAt = (vehicleId, midMs) => trips.some(trip => trip.vehicle_id === vehicleId &&
    Date.parse(trip.starts_at) <= midMs && midMs < Date.parse(trip.ends_at));
  const dayHead = days.map(day => {
    const iso = day.toISOString().slice(0, 10);
    const weekend = [0, 6].includes(day.getUTCDay());
    return `<th class="${weekend ? 'sched-we' : ''} ${iso === todayIso ? 'sched-today' : ''}">
      ${new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'numeric', timeZone: 'UTC' }).format(day)}</th>`;
  }).join('');
  const permAt = (driverId, midMs) => {
    const span = (assignments[driverId] || []).find(item =>
      (item.from == null || Date.parse(item.from) <= midMs) &&
      (item.to == null || Date.parse(item.to) > midMs));
    return span ? span.vehicleId : null;
  };
  // Машина водителя на день: периодное закрепление приоритетнее постоянного.
  const vehicleAtDay = (driverId, midMs) => {
    const period = plannedAt(planned, midMs, 'driver_id', driverId)[0];
    return period ? period.vehicle_id : permAt(driverId, midMs);
  };
  const dispoAt = (vehicleId, dayStartMs) => dispositions.filter(item =>
    item.vehicle_id === vehicleId &&
    Date.parse(item.starts_at) < dayStartMs + 86_400_000 &&
    Date.parse(item.ends_at) > dayStartMs);
  const absentAt = (driver, midMs) => driver.absent_from && driver.absent_to &&
    Date.parse(driver.absent_from) <= midMs && Date.parse(driver.absent_to) >= midMs;
  // Цвет ячейки — главный носитель информации (значки убраны): палитра
  // совпадает с плашками-состояниями сверху. Приоритет: выведена → без
  // водителя → ремонт → пересменка → резерв → в рейсе → отдых человека.
  // Явка — цветная кромка слева; периодное закрепление — пунктирная рамка.
  const dispoClass = kinds =>
    kinds.includes('out') ? 'sk-out'
    : kinds.includes('no_driver') ? 'sk-nodrv'
    : kinds.includes('repair') ? 'sk-repair'
    : kinds.includes('shift') ? 'sk-shift'
    : kinds.includes('reserve') ? 'sk-reserve' : '';

  let body;
  if (view === 'drivers') {
    body = drivers.map(driver => {
      const cells = days.map(day => {
        const iso = day.toISOString().slice(0, 10);
        const midMs = day.getTime() + 43_200_000;
        const period = plannedAt(planned, midMs, 'driver_id', driver.id)[0];
        const vehicleId = period ? period.vehicle_id : permAt(driver.id, midMs);
        const att = attByDriver.get(`${driver.id}|${iso}`);
        const absent = absentAt(driver, midMs);
        const shift = shiftStateAt(driver, iso);
        const restText = absent ? (driver.status === 'sick' ? 'болен' : 'отпуск')
          : shift?.rest ? 'межвахта' : null;
        const kinds = vehicleId ? dispoAt(vehicleId, day.getTime()).map(item => item.kind) : [];
        const cls = [
          restText ? 'sk-rest'
            : dispoClass(kinds) || (vehicleId && tripAt(vehicleId, midMs) ? 'sched-trip' : ''),
          att?.status === 'present' ? 'att-ok' : att?.status === 'absent' ? 'att-bad' : '',
          period ? 'sk-period' : '',
          canWrite ? 'sched-act' : ''
        ].filter(Boolean).join(' ');
        const title = [vehicleId ? plateOf.get(vehicleId) : 'без сцепки',
          period ? `закреплён на период до ${String(period.ends_at).slice(0, 10)}${period.note ? ` (${period.note})` : ''}` : '',
          att ? (att.status === 'present' ? 'вышел' : `невыход: ${att.reason}`) : '',
          restText ? `${restText}${shift?.rest ? ` до ${shift.until}` : ''}` : '',
          !restText && shift ? `вахта до ${shift.until}` : '',
          ...kinds.map(kind => kindMeta(kind).label.toLowerCase())]
          .filter(Boolean).join(' · ');
        return `<td class="${cls}" ${canWrite
            ? `data-sched-driver="${driver.id}" data-sched-day="${iso}"` : ''}
          title="${escapeHtml(title)}${canWrite ? ' · клик — назначить ТС на период' : ''}">
          ${restText ? `<i class="sk-dim">${restText}</i>`
            : `<span class="mono">${escapeHtml(plateOf.get(vehicleId) || '—')}</span>`}</td>`;
      }).join('');
      return `<tr><th class="sched-name">${escapeHtml(shortName(driver.full_name))}</th>${cells}</tr>`;
    }).join('');
  } else {
    body = vehicles.map(vehicle => {
      const cells = days.map(day => {
        const iso = day.toISOString().slice(0, 10);
        const midMs = day.getTime() + 43_200_000;
        const periodHolders = plannedAt(planned, midMs, 'vehicle_id', vehicle.id)
          .map(item => driverById.get(item.driver_id)).filter(Boolean);
        const permHolders = payload.drivers.filter(driver =>
          permAt(driver.id, midMs) === vehicle.id &&
          !plannedAt(planned, midMs, 'driver_id', driver.id).length);
        const holders = [...periodHolders, ...permHolders];
        const resting = holders.filter(driver => shiftStateAt(driver, iso)?.rest ||
          absentAt(driver, midMs));
        const activeHolders = holders.filter(driver => !resting.includes(driver));
        const dispo = dispoAt(vehicle.id, day.getTime());
        const kinds = dispo.map(item => item.kind);
        const inTrip = tripAt(vehicle.id, midMs);
        // Основной водитель на выходных без подмены = машина фактически без
        // водителя: тон «без водителя», имя — приглушённой справкой.
        const noDriverDay = !activeHolders.length;
        const cls = [
          kinds.includes('out') ? 'sk-out'
            : kinds.includes('no_driver') || noDriverDay ? 'sk-nodrv'
            : dispoClass(kinds) || (inTrip ? 'sched-trip' : ''),
          periodHolders.length ? 'sk-period' : '',
          canWrite ? 'sched-act' : ''
        ].filter(Boolean).join(' ');
        const title = [holders.map(driver => {
            const shift = shiftStateAt(driver, iso);
            const period = plannedAt(planned, midMs, 'driver_id', driver.id)[0];
            return driver.full_name + (period ? ' (на период)' : '') +
              (absentAt(driver, midMs) ? ' (отсутствие)'
                : shift ? (shift.rest ? ` (межвахта до ${shift.until})` : ` (вахта до ${shift.until})`) : '');
          }).join(', ') || 'водитель не закреплён',
          inTrip ? 'в рейсе' : '',
          ...kinds.map(kind => kindMeta(kind).label.toLowerCase())].filter(Boolean).join(' · ');
        return `<td class="${cls}" ${canWrite
            ? `data-sched-vehicle="${vehicle.id}" data-sched-day="${iso}"` : ''}
          title="${escapeHtml(title)}${canWrite ? ' · клик — назначить водителя на период' : ''}">
          ${activeHolders.length
            ? escapeHtml(activeHolders.map(driver => shortName(driver.full_name)).join(', '))
            : holders.length
              ? `<i class="sk-dim">${escapeHtml(shortName(holders[0].full_name))} · вых</i>`
              : '<i class="sk-dim">нет водителя</i>'}</td>`;
      }).join('');
      return `<tr><th class="sched-name mono vlink" data-vinfo="${vehicle.id}"
        title="Карточка ТС">${escapeHtml(vehicle.plate)}</th>${cells}</tr>`;
    }).join('');
  }
  const total = view === 'drivers' ? payload.drivers.length : payload.vehicles.length;
  const shown = view === 'drivers' ? drivers.length : vehicles.length;
  const legend = `<p class="sched-legend">
    <span><i class="lg-chip" style="--c:#3f8a78"></i> в рейсе</span>
    <span><i class="lg-chip" style="--c:#5e87ad"></i> пересменка</span>
    <span><i class="lg-chip" style="--c:#b06a55"></i> без водителя</span>
    <span><i class="lg-chip" style="--c:#bd8f42"></i> ремонт</span>
    <span><i class="lg-chip" style="--c:#5a9e54"></i> резерв</span>
    <span><i class="lg-chip" style="--c:#8a7fb3"></i> межвахта/отпуск</span>
    <span><i class="lg-edge" style="--c:var(--ok)"></i> вышел</span>
    <span><i class="lg-edge" style="--c:var(--bad)"></i> невыход</span>
    <span><i class="lg-dash"></i> закреплён на период</span></p>`;
  return `${legend}${shown < total ? `<p class="muted" style="margin:6px 10px">Фильтр: показано ${shown} из ${total}.
      ${shown ? '' : 'Ничего не подходит — сбросьте плашку-состояние или поиск.'}</p>` : ''}
    <table class="sched-table">
    <thead><tr><th class="sched-name">${view === 'drivers' ? 'Водитель' : 'Сцепка'}</th>${dayHead}</tr></thead>
    <tbody>${body}</tbody></table>`;
}

// Периодное закрепление: форма + список действующих с удалением.
export function periodAssignDialog(context, preset = {}) {
  const { state } = context;
  const data = state.data;
  const today = new Date().toISOString().slice(0, 10);
  const items = (data.driverAssignments || [])
    .filter(item => String(item.ends_at).slice(0, 10) >= today)
    .sort((a, b) => String(a.starts_at).localeCompare(String(b.starts_at)));
  const canWrite = (data.user.permissions || []).includes('fleet:write');
  context.showModal(`<h2>📌 Закрепление на период</h2>
    <p class="muted">Подмена на межвахту или командировка: водитель работает на этой сцепке
      в заданные даты — поверх постоянного закрепления. Один водитель не может быть
      на двух ТС внахлёст.</p>
    ${canWrite ? `<form id="periodForm">
      <div class="form-grid">
        <label class="field">Водитель
          <input id="paDriverSearch" placeholder="🔍 фамилия" autocomplete="off">
          <select name="driverId" style="margin-top:4px">${(data.drivers || [])
            .map(driver => `<option value="${driver.id}" ${driver.id === preset.driverId ? 'selected' : ''}>${escapeHtml(driver.full_name)}${driver.vehicle_plate ? ` · ${escapeHtml(driver.vehicle_plate)}` : ''}</option>`).join('')}</select></label>
        <label class="field">Сцепка
          <input id="paVehicleSearch" placeholder="🔍 номер" autocomplete="off">
          <select name="vehicleId" style="margin-top:4px">${data.vehicles
            .filter(vehicle => vehicle.status !== 'out')
            .map(vehicle => `<option value="${vehicle.id}" ${vehicle.id === preset.vehicleId ? 'selected' : ''}>${escapeHtml(vehicle.plate)} · ${escapeHtml(vehicle.driver_name || 'без водителя')}</option>`).join('')}</select></label>
      </div>
      <div class="form-grid">
        <label class="field">С<input name="startsAt" type="date" required value="${preset.from || today}"></label>
        <label class="field">По (не включая)<input name="endsAt" type="date" required value="${preset.to || ''}"></label>
      </div>
      <label class="field">Заметка<input name="note" maxlength="200" placeholder="подмена на межвахту, командировка…"></label>
      <div class="modal-actions">
        <button type="button" class="button ghost" data-close>Закрыть</button>
        <button class="button">Закрепить</button>
      </div>
    </form>` : '<p class="muted">Изменения доступны роли с правом на парк.</p>'}
    <h3 style="margin-top:12px">Действующие и будущие <span class="scount">${items.length}</span></h3>
    <div class="list" style="max-height:30vh;overflow:auto">${items.map(item => `
      <div class="list-item" style="padding:5px 8px">
        <span style="flex:1;min-width:0"><b>${escapeHtml(item.driver_name)}</b>
          → <span class="mono">${escapeHtml(item.vehicle_plate)}</span>
          <small class="muted" style="display:block">${String(item.starts_at).slice(0, 10)} → ${String(item.ends_at).slice(0, 10)}${item.note ? ` · ${escapeHtml(item.note)}` : ''}</small></span>
        ${canWrite ? `<button class="button ghost small danger" data-pa-del="${item.id}">✕</button>` : ''}
      </div>`).join('') || '<p class="muted">Периодных закреплений нет.</p>'}</div>`);
  if (canWrite) {
    wireSelectSearch(document.getElementById('paDriverSearch'),
      document.querySelector('#periodForm [name=driverId]'));
    wireSelectSearch(document.getElementById('paVehicleSearch'),
      document.querySelector('#periodForm [name=vehicleId]'));
    document.getElementById('periodForm').onsubmit = async event => {
      event.preventDefault();
      const values = formValues(event.currentTarget);
      try {
        await api('/api/driver-assignments', { method: 'POST', body: JSON.stringify(values) });
        toast('Закрепление на период сохранено');
        await context.onReload();
        periodAssignDialog(context);
      } catch (error) { toast(error.message, 'error'); }
    };
  }
  document.querySelectorAll('[data-pa-del]').forEach(button =>
    button.addEventListener('click', async () => {
      if (!confirm('Удалить периодное закрепление?')) return;
      try {
        await api(`/api/driver-assignments/${button.dataset.paDel}`, { method: 'DELETE' });
        toast('Закрепление удалено');
        await context.onReload();
        periodAssignDialog(context);
      } catch (error) { toast(error.message, 'error'); }
    }));
}

// Асинхронная дорисовка сетки графика во вкладке (данные — /api/driver-schedule).
async function loadResourceSchedule(container, context) {
  const { state } = context;
  const box = container.querySelector('#resScheduleWrap');
  if (!box) return;
  const DAYS = 14;
  const startIso = state.resourceSchedStart ||
    new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
  const endIso = new Date(Date.parse(`${startIso}T00:00:00Z`) + DAYS * 86_400_000)
    .toISOString().slice(0, 10);
  let payload;
  try {
    payload = await api(`/api/driver-schedule?from=${startIso}&to=${endIso}`);
  } catch (error) {
    box.innerHTML = `<p class="muted">${escapeHtml(error.message)}</p>`;
    return;
  }
  const canWrite = (state.data.user.permissions || []).includes('fleet:write');
  const monthEnd = new Date(Date.UTC(state.month.getUTCFullYear(), state.month.getUTCMonth() + 1, 1));
  const today = new Date().toISOString().slice(0, 10);
  const refDay = state.resourceDay ||
    (today >= state.month.toISOString().slice(0, 10) && today < monthEnd.toISOString().slice(0, 10)
      ? today : state.month.toISOString().slice(0, 10));
  const keepLeft = box.scrollLeft;
  const keepTop = box.scrollTop;
  box.innerHTML = buildScheduleTable({ payload, data: state.data,
    view: state.resourceView === 'drivers' ? 'drivers' : 'vehicles', startIso, days: DAYS,
    query: state.resourceQuery || '', filterKind: state.resourceFilter || null,
    refDay, canWrite });
  box.scrollLeft = keepLeft;
  box.scrollTop = keepTop;
  // Клик по ячейке — периодное закрепление с подставленной машиной/водителем
  // и датами от дня клика (неделя по умолчанию, в форме правится).
  if (canWrite) {
    box.addEventListener('click', event => {
      const cell = event.target.closest('[data-sched-day]');
      if (!cell || event.target.closest('.vlink')) return;
      const from = cell.dataset.schedDay;
      const to = new Date(Date.parse(`${from}T00:00:00Z`) + 7 * 86_400_000)
        .toISOString().slice(0, 10);
      periodAssignDialog(context, {
        vehicleId: cell.dataset.schedVehicle || undefined,
        driverId: cell.dataset.schedDriver || undefined,
        from, to
      });
    });
  }
}

// Явка водителей (контур ОУВ, перенос из v2): отметки за день с
// классификацией причин невыхода — каждый невыход обязан иметь причину.
async function attendanceDialog(context) {
  let day = new Date().toISOString().slice(0, 10);
  const render = async () => {
    let payload;
    try {
      payload = await api(`/api/attendance?day=${day}`);
    } catch (error) { toast(error.message, 'error'); return; }
    const { summary, reasons, items } = payload;
    const staffingOk = summary.staffing >= summary.staffingTarget;
    const rows = items.map(item => `<div class="list-item" style="padding:5px 8px;gap:8px">
      <span style="flex:1;min-width:0"><strong>${escapeHtml(item.full_name)}</strong>
        <small class="muted" style="display:block">${escapeHtml(item.vehicle_plate || 'без сцепки')}${item.note ? ` · ${escapeHtml(item.note)}` : ''}</small></span>
      <button class="button small ${item.status === 'present' ? '' : 'ghost'}"
        data-att="present" data-driver="${item.driver_id}">✓ Вышел</button>
      <button class="button small ${item.status === 'absent' ? '' : 'ghost'}"
        data-att="absent" data-driver="${item.driver_id}">✗ Невыход</button>
      <select data-att-reason="${item.driver_id}" ${item.status === 'absent' ? '' : 'disabled'}
        style="width:150px">
        <option value="">— причина —</option>
        ${Object.entries(reasons).map(([key, label]) =>
          `<option value="${key}" ${item.reason === key ? 'selected' : ''}>${label}</option>`).join('')}
      </select>
    </div>`).join('');
    context.showModal(`<h2 style="margin-bottom:6px">Явка водителей</h2>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:8px">
        <input type="date" id="attDay" value="${day}" style="width:auto">
        <span class="badge ok">вышли: ${summary.present}</span>
        <span class="badge ${summary.absent ? 'bad' : ''}">невыход: ${summary.absent}</span>
        <span class="badge ${summary.unmarked ? 'warn' : 'ok'}" title="Каждый невыход обязан иметь причину из классификатора">не отмечено: ${summary.unmarked}</span>
        <span class="badge ${staffingOk ? 'ok' : 'bad'}"
          title="Норматив укомплектованности — 1,45 водителя на сцепку">
          укомплектованность: ${summary.staffing.toFixed(2)} / ${summary.staffingTarget}</span>
      </div>
      <div class="list" style="max-height:56vh;overflow:auto">${rows}</div>
      <div class="modal-actions"><button type="button" class="button" data-close>Закрыть</button></div>`, 'wide');
    document.getElementById('attDay').onchange = event => {
      day = event.currentTarget.value || day;
      render();
    };
    const mark = async body => {
      try {
        await api('/api/attendance', { method: 'POST', body: JSON.stringify({ ...body, day }) });
        render();
      } catch (error) { toast(error.message, 'error'); }
    };
    document.querySelectorAll('[data-att]').forEach(button => button.onclick = () => {
      const driverId = button.dataset.driver;
      if (button.dataset.att === 'present') return mark({ driverId, status: 'present' });
      const reason = document.querySelector(`[data-att-reason="${driverId}"]`).value;
      if (!reason) {
        document.querySelector(`[data-att-reason="${driverId}"]`).disabled = false;
        toast('Выберите причину невыхода — без неё отметка не принимается', 'error');
        return;
      }
      mark({ driverId, status: 'absent', reason });
    });
    document.querySelectorAll('[data-att-reason]').forEach(select => select.onchange = () => {
      if (select.value) mark({ driverId: select.dataset.attReason, status: 'absent', reason: select.value });
    });
  };
  await render();
}

const nextDayIso = dayIso => new Date(Date.parse(`${dayIso}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

// Состояние сцепки на день: диспозиция > статус ТС > рейс > без заказа.
export function vehicleStateAt(vehicle, data, dayIso) {
  const midpoint = Date.parse(`${dayIso}T12:00:00Z`);
  // Интервал объясняет день, если пересекает его: короткий дневной ремонт —
  // тоже причина, а не «простой». Из нескольких — больший по перекрытию.
  const dayStart = Date.parse(`${dayIso}T00:00:00Z`);
  const dayCeil = dayStart + 86_400_000;
  const overlapMs = item => Math.min(Date.parse(item.ends_at), dayCeil) -
    Math.max(Date.parse(item.starts_at), dayStart);
  const disposition = (data.dispositions || [])
    .filter(item => item.vehicle_id === vehicle.id &&
      Date.parse(item.starts_at) < dayCeil && Date.parse(item.ends_at) > dayStart)
    .sort((a, b) => overlapMs(b) - overlapMs(a))[0];
  if (disposition) return kindMeta(disposition.kind);
  if (vehicle.status === 'out') return kindMeta('out');
  if (vehicle.status === 'repair') return kindMeta('repair');
  if (vehicle.status === 'no_driver' || !vehicle.driver_name) return kindMeta('no_driver');
  const onTrip = data.trips.some(trip => trip.vehicle_id === vehicle.id && trip.status !== 'rejected' &&
    Date.parse(trip.starts_at) <= midpoint && midpoint < Date.parse(trip.ends_at));
  return onTrip ? kindMeta('work') : kindMeta('idle');
}

// Задания ресурсника: машины, по которым на выбранную дату нет ни заказа,
// ни заполненной диспозиции — по каждой нужно либо дать заказ (логисту),
// либо оформить причину простоя. Давно простаивающие — сверху.
function renderResourceTasks(container, context, refDay, withState) {
  const { state } = context;
  const data = state.data;
  const midpoint = Date.parse(`${refDay}T12:00:00Z`);
  const tasks = withState
    .filter(({ stateNow }) => stateNow.kind === 'idle' || stateNow.kind === 'no_driver')
    .map(({ vehicle, stateNow }) => {
      // Незаполненная диспозиция: состояние вычислено из карточки/простоя,
      // но интервального объяснения в календаре нет.
      const dayStart = Date.parse(`${refDay}T00:00:00Z`);
      const hasDisposition = (data.dispositions || []).some(item =>
        item.vehicle_id === vehicle.id &&
        Date.parse(item.starts_at) < dayStart + 86_400_000 &&
        Date.parse(item.ends_at) > dayStart);
      if (hasDisposition) return null;
      const lastTrip = data.trips
        .filter(trip => trip.vehicle_id === vehicle.id && trip.status !== 'rejected' &&
          Date.parse(trip.ends_at) <= midpoint)
        .sort((a, b) => b.ends_at.localeCompare(a.ends_at))[0];
      const idleMs = lastTrip ? midpoint - Date.parse(lastTrip.ends_at) : null;
      return { vehicle, stateNow, lastTrip, idleMs };
    })
    .filter(Boolean)
    .sort((a, b) => (b.idleMs ?? Infinity) - (a.idleMs ?? Infinity));

  const idleLabel = ms => {
    if (ms == null) return 'без рейсов в данных';
    const days = Math.floor(ms / 86_400_000);
    return days >= 1 ? `простой ${days} дн` : `простой ${Math.max(1, Math.floor(ms / 3_600_000))} ч`;
  };

  // Дыры по водителям на ближайшую неделю: у машины нет действующего
  // водителя на день (постоянный отсутствует/на межвахте и периодной
  // подмены нет) — задание «назначить водителя на ТС».
  const noDriverTasks = [];
  const planned = data.driverAssignments || [];
  for (const vehicle of data.vehicles.filter(item => item.status === 'work')) {
    let gapFrom = null;
    let gapTo = null;
    for (let offset = 0; offset < 7; offset += 1) {
      const dayMs = Date.parse(`${refDay}T00:00:00Z`) + offset * 86_400_000;
      const iso = new Date(dayMs).toISOString().slice(0, 10);
      const midMs = dayMs + 43_200_000;
      const periodHolder = planned.some(item => item.vehicle_id === vehicle.id &&
        Date.parse(item.starts_at) <= midMs && Date.parse(item.ends_at) > midMs);
      if (periodHolder) continue;
      const perm = (data.drivers || []).find(driver => driver.vehicle_id === vehicle.id);
      const permAway = !perm ||
        (perm.absent_from && perm.absent_to &&
          Date.parse(perm.absent_from) <= midMs && Date.parse(perm.absent_to) >= midMs) ||
        shiftStateAt(perm, iso)?.rest ||
        planned.some(item => item.driver_id === perm.id && item.vehicle_id !== vehicle.id &&
          Date.parse(item.starts_at) <= midMs && Date.parse(item.ends_at) > midMs);
      if (permAway) {
        if (!gapFrom) gapFrom = iso;
        gapTo = new Date(dayMs + 86_400_000).toISOString().slice(0, 10);
      }
    }
    if (gapFrom) noDriverTasks.push({ vehicle, gapFrom, gapTo });
  }

  container.innerHTML = `<h2>Задания ресурса</h2>
    <p class="muted">На ${refDay.split('-').reverse().join('.')}: ТС без заказа и без
      заполненной диспозиции — оформите причину простоя или передайте логисту.</p>
    <div class="summary-grid">
      <div class="metric"><span>Требуют внимания</span><strong>${tasks.length}</strong></div>
      <div class="metric"><span>Всего в парке</span><strong>${withState.length}</strong></div>
    </div>
    ${noDriverTasks.length ? `<div class="task-sec"><b>👤 Назначить водителя на ТС (${noDriverTasks.length})</b>
      <div class="list" style="margin-top:6px">${noDriverTasks.slice(0, 8).map(task => `
        <div class="list-item" style="padding:6px 9px">
          <span style="flex:1;min-width:0"><strong class="mono">${escapeHtml(task.vehicle.plate)}</strong>
            <small class="muted" style="display:block">без водителя ${task.gapFrom.split('-').reverse().slice(0, 2).join('.')} → ${task.gapTo.split('-').reverse().slice(0, 2).join('.')}
              ${task.vehicle.driver_name ? `· постоянный: ${escapeHtml(task.vehicle.driver_name)}` : '· постоянного нет'}</small></span>
          <button class="button small" data-task-assign-driver="${task.vehicle.id}"
            data-gap-from="${task.gapFrom}" data-gap-to="${task.gapTo}"
            title="Периодное закрепление подменного водителя на эти даты">Назначить</button>
        </div>`).join('')}${noDriverTasks.length > 8 ? `<p class="muted">…и ещё ${noDriverTasks.length - 8}</p>` : ''}</div></div>` : ''}
    <div class="list">${tasks.map(({ vehicle, stateNow, lastTrip, idleMs }) => `
      <div class="list-item pipe-mine" style="flex-wrap:wrap">
        <span style="flex:1;min-width:0">
          <strong class="mono">${escapeHtml(vehicle.plate)}</strong>
          <span style="color:${stateNow.color};font-size:var(--fs-xs);font-weight:700"> · ${stateNow.label}</span>
          <small class="muted" style="display:block">${escapeHtml(vehicle.driver_name || 'без водителя')} · ${idleLabel(idleMs)}</small>
          ${lastTrip ? `<small class="muted" style="display:block">последний рейс: ${escapeHtml(lastTrip.to_point || lastTrip.to_name)} · ${formatDateTime(lastTrip.ends_at)}</small>` : ''}
        </span>
        <span style="display:flex;gap:5px">
          ${stateNow.kind === 'idle' ? `<button class="button small" data-task-load="${vehicle.id}"
            title="Авто-сообщение продажам: сцепка свободна, подберите заявку">Запросить загрузку</button>` : ''}
          <button class="button ghost small" data-task-disposition="${vehicle.id}">Диспозиция</button>
        </span>
      </div>`).join('') || '<p class="muted">Все машины при деле: у каждой есть заказ или оформленный простой.</p>'}
    </div>`;

  container.querySelectorAll('[data-task-assign-driver]').forEach(button =>
    button.addEventListener('click', () => periodAssignDialog(context, {
      vehicleId: button.dataset.taskAssignDriver,
      from: button.dataset.gapFrom, to: button.dataset.gapTo
    })));
  container.querySelectorAll('[data-task-disposition]').forEach(button =>
    button.addEventListener('click', () => context.openDisposition(null, {
      vehicle_id: button.dataset.taskDisposition,
      // Сутки refDay в часовом поясе предприятия, а не UTC.
      starts_at: fromLocalInput(`${refDay}T00:00`),
      ends_at: fromLocalInput(`${nextDayIso(refDay)}T00:00`)
    })));
  // Замыкание задания: запрос загрузки уходит продажам авто-сообщением
  // (им придёт тост со звуком), сцепку подберут в «Потребности от логистики».
  container.querySelectorAll('[data-task-load]').forEach(button =>
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await api(`/api/vehicles/${button.dataset.taskLoad}/request-load`, { method: 'POST' });
        toast('Продажи уведомлены — запрос загрузки отправлен');
      } catch (error) {
        button.disabled = false;
        toast(error.message, 'error');
      }
    }));
}

export function renderResource(container, context) {
  const { state } = context;
  const data = state.data;
  // Разметка и метрики главного ганта: та же ширина дня, sticky-шапка и колонка,
  // выходные и маркер «сегодня» — ресурс выглядит и ведёт себя как гант.
  const dayWidth = Number(data.settings.general.plannerCellWidth || 44);
  document.documentElement.style.setProperty('--planner-day-width', `${dayWidth}px`);
  const monthEnd = new Date(Date.UTC(state.month.getUTCFullYear(), state.month.getUTCMonth() + 1, 1));
  const days = Math.round((monthEnd - state.month) / 86_400_000);
  const today = new Date().toISOString().slice(0, 10);
  const monthIso = state.month.toISOString().slice(0, 10);
  const inMonth = today >= monthIso && today < monthEnd.toISOString().slice(0, 10);
  const refDay = state.resourceDay || (inMonth ? today : monthIso);
  const filter = state.resourceFilter || null;
  const todayIndex = Math.floor((Date.now() - state.month.getTime()) / 86_400_000);

  const withState = data.vehicles.map(vehicle => ({
    vehicle, stateNow: vehicleStateAt(vehicle, data, refDay)
  }));
  const counts = {};
  withState.forEach(({ stateNow }) => { counts[stateNow.kind] = (counts[stateNow.kind] || 0) + 1; });
  // Режим фильтрации: состояние на день + текстовый поиск по сцепке.
  const query = (state.resourceQuery || '').toLowerCase();
  const visible = withState
    .filter(({ stateNow }) => !filter || stateNow.kind === filter)
    .filter(({ vehicle }) => !query ||
      `${vehicle.plate} ${vehicle.trailer_plate || ''} ${vehicle.driver_name || ''} ${vehicle.type_name || ''}`
        .toLowerCase().includes(query));

  const badges = DISP_KINDS.map(item =>
    `<button class="dbadge ${filter === item.kind ? 'on' : ''}" data-kind="${item.kind}" style="--dc:${item.color}">
      <span class="dbn">${counts[item.kind] || 0}</span><span class="dbl">${item.short}</span></button>`).join('');

  const headerDays = Array.from({ length: days }, (_, index) => {
    const date = new Date(Date.UTC(state.month.getUTCFullYear(), state.month.getUTCMonth(), index + 1));
    const weekend = [0, 6].includes(date.getUTCDay());
    return `<div class="day-cell ${weekend ? 'weekend' : ''} ${index === todayIndex ? 'today' : ''}"><strong>${index + 1}</strong>
      <small>${new Intl.DateTimeFormat('ru-RU', { weekday: 'short', timeZone: 'UTC' }).format(date)}</small></div>`;
  }).join('');

  const grid = Array.from({ length: days }, (_, index) => {
    const date = new Date(Date.UTC(state.month.getUTCFullYear(), state.month.getUTCMonth(), index + 1));
    return `<div class="grid-day ${[0, 6].includes(date.getUTCDay()) ? 'weekend' : ''} ${index === todayIndex ? 'today' : ''}"></div>`;
  }).join('');

  const rows = visible.map(({ vehicle, stateNow }) => {
    const monthTrips = data.trips
      .filter(trip => trip.vehicle_id === vehicle.id && trip.status !== 'rejected' &&
        new Date(trip.starts_at) < monthEnd && new Date(trip.ends_at) > state.month);
    const trips = monthTrips.map(trip => {
      const start = Math.max(0, (Date.parse(trip.starts_at) - state.month.getTime()) / 86_400_000);
      const end = Math.min(days, (Date.parse(trip.ends_at) - state.month.getTime()) / 86_400_000);
      const width = Math.max((end - start) * dayWidth - 2, 6);
      const route = `${trip.from_point || trip.from_name}→${trip.to_point || trip.to_name}`;
      // Информативная плашка: маршрут прямо на полосе (когда влезает) и полный
      // тултип — заказчик, времена, статус.
      return `<span class="tripu" style="left:${(start * dayWidth).toFixed(0)}px;width:${width.toFixed(0)}px"
        title="${escapeHtml(route)} · ${escapeHtml(trip.customer_name || 'без заказчика')}
${formatDateTime(trip.starts_at)} → ${formatDateTime(trip.ends_at)}">${width >= 68 ? escapeHtml(route) : ''}</span>`;
    }).join('');
    const bars = (data.dispositions || [])
      .filter(item => item.vehicle_id === vehicle.id &&
        new Date(item.starts_at) < monthEnd && new Date(item.ends_at) > state.month)
      .map(item => {
        const meta = kindMeta(item.kind);
        const start = Math.max(0, (Date.parse(item.starts_at) - state.month.getTime()) / 86_400_000);
        const end = Math.min(days, (Date.parse(item.ends_at) - state.month.getTime()) / 86_400_000);
        return `<span class="dbar" data-disposition="${item.id}"
          style="left:${(start * dayWidth).toFixed(0)}px;width:${Math.max((end - start) * dayWidth - 3, 18).toFixed(0)}px;background:${meta.color}"
          title="${meta.label} · ${formatDateTime(item.starts_at)} → ${formatDateTime(item.ends_at)}${item.note ? `
${escapeHtml(item.note)}` : ''}"><b>${meta.short}</b>${item.note ? ` · ${escapeHtml(item.note)}` : ''}</span>`;
      }).join('');
    // Занятость за месяц — сразу видно недогруженные сцепки.
    const busyDays = Math.min(days, Math.round(monthTrips.reduce((sum, trip) =>
      sum + (Math.min(monthEnd, new Date(trip.ends_at)) - Math.max(state.month, new Date(trip.starts_at))) / 86_400_000, 0)));
    return `<div class="vehicle-row">
      <div class="vehicle-cell"><span class="vehicle-stripe" style="background:${stateNow.color}"></span>
        <span class="vehicle-title res-vtitle"><strong class="mono vlink" data-vinfo="${vehicle.id}"
          title="Карточка ТС: рейс, простой, ремонт, отметки контролёра">${escapeHtml(vehicle.plate)}</strong>
        <small>${escapeHtml(vehicle.driver_name || 'без водителя')} · <span style="color:${stateNow.color}">${stateNow.label}</span></small>
        <small>${escapeHtml(vehicle.trailer_plate || 'без прицепа')} · ${escapeHtml(vehicle.type_name || '')} · ${monthTrips.length} р. / ${busyDays} дн</small></span>
      </div>
      <div class="track" data-vehicle="${vehicle.id}" style="width:${days * dayWidth}px">
        <div class="track-grid">${grid}</div>${trips}${bars}</div>
    </div>`;
  }).join('');

  container.innerHTML = `<div class="resboard">
    <div class="reshead">
      <div class="dbadges">${badges}${filter ? '<button class="dbadge clear" data-kind="">✕ сброс</button>' : ''}</div>
      <div class="resctl">
        <input id="resourceSearch" class="block-search" placeholder="Поиск: тягач, прицеп, водитель"
          value="${escapeHtml(state.resourceQuery || '')}">
        ${filter || query ? `<span class="muted" style="font-size:var(--fs-xs)">показано ${visible.length} из ${withState.length}</span>` : ''}
        <span class="muted" style="font-size:var(--fs-xs)">Состояние на день</span>
        <input type="date" id="resourceDay" value="${refDay}">
        ${context.openStats ? '<button class="button ghost small" id="resourceStats" title="Машино-дни, КТГ и выручка по каждой сцепке за месяц">Аналитика</button>' : ''}
        ${context.openDrivers ? '<button class="button ghost small" id="resourceDrivers" title="Справочник водителей: закрепление, отпуска, кто без машины">Водители</button>' : ''}
        <button class="button ghost small" id="resourceAttendance"
          title="Явка водителей на день: невыход — только с причиной из классификатора">Явка</button>
        <button class="button small ${state.resourceView !== 'gantt' && state.resourceView !== 'drivers' ? '' : 'ghost'}"
          id="resViewTs" title="График работы: строка — сцепка, в ячейках водитель по дням">📅 По ТС</button>
        <button class="button small ${state.resourceView === 'drivers' ? '' : 'ghost'}"
          id="resViewDrivers" title="График работы: строка — водитель, в ячейках сцепка по дням">👤 По водителям</button>
        <button class="button small ${state.resourceView === 'gantt' ? '' : 'ghost'}"
          id="resViewGantt" title="Классический гант ресурса: рейсы и интервалы недоступности">Гант</button>
        ${state.resourceView !== 'gantt' ? `<input type="date" id="resSchedStart"
          value="${state.resourceSchedStart || new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10)}"
          title="Начало периода графика (14 дней)" style="width:auto">` : ''}
        <button class="button ghost small" id="resourcePeriod"
          title="Периодные закрепления водителей за ТС: подмены на межвахту, командировки">📌 На период</button>
        ${context.openFleet ? '<button class="button ghost small" id="resourceFleet" title="Весь парк: карточки, замена водителя и прицепа, планирование">Справочник ТС</button>' : ''}
        <button class="button small" id="resourceAdd">+ диспозиция</button>
      </div>
    </div>
    ${state.resourceView === 'gantt' ? `<div class="resscroll">
      <div class="timeline">
        <div class="timeline-head"><div class="vehicle-cell">Сцепка · водитель</div>${headerDays}</div>
        ${rows || '<div class="empty-state">Нет ТС в выбранном состоянии</div>'}
      </div>
    </div>` : `<div class="sched-wrap" id="resScheduleWrap" style="max-height:none">
      <p class="muted" style="padding:10px">⏳ Загружаю график работы…</p>
    </div>`}
  </div>`;

  // Фокус как в главном ганте: «сегодня −3 дня» при первом показе месяца.
  if (todayIndex >= 0 && todayIndex < days && state.resourceScrolledMonth !== state.month.getTime()) {
    state.resourceScrolledMonth = state.month.getTime();
    const scroller = container.querySelector('.resscroll');
    if (scroller) scroller.scrollLeft = Math.max(0, todayIndex - 3) * dayWidth;
  }

  // Панель заданий сотрудника справа (по аналогии с боковой панелью ганта).
  if (context.taskContainer) renderResourceTasks(context.taskContainer, context, refDay, withState);

  container.querySelectorAll('.dbadge').forEach(button =>
    button.addEventListener('click', () => {
      const kind = button.dataset.kind;
      state.resourceFilter = kind && kind !== filter ? kind : null;
      renderResource(container, context);
    }));
  container.querySelector('#resourceDay').onchange = event => {
    state.resourceDay = event.currentTarget.value;
    renderResource(container, context);
  };
  attachSearch(container.querySelector('#resourceSearch'), value => {
    state.resourceQuery = value;
    renderResource(container, context);
  });
  if (context.openStats) container.querySelector('#resourceStats').onclick = () => context.openStats();
  if (context.openDrivers) container.querySelector('#resourceDrivers').onclick = () => context.openDrivers();
  container.querySelector('#resourceAttendance').onclick = () => attendanceDialog(context);
  container.querySelector('#resourcePeriod').onclick = () => periodAssignDialog(context);
  const setView = view => { state.resourceView = view; renderResource(container, context); };
  container.querySelector('#resViewTs').onclick = () => setView('ts');
  container.querySelector('#resViewDrivers').onclick = () => setView('drivers');
  container.querySelector('#resViewGantt').onclick = () => setView('gantt');
  container.querySelector('#resSchedStart')?.addEventListener('change', event => {
    state.resourceSchedStart = event.currentTarget.value || null;
    renderResource(container, context);
  });
  if (state.resourceView !== 'gantt') loadResourceSchedule(container, context);
  if (context.openFleet) container.querySelector('#resourceFleet').onclick = () => context.openFleet();
  container.querySelector('#resourceAdd').onclick = () => context.openDisposition(null, {
    vehicle_id: data.vehicles[0]?.id,
    starts_at: fromLocalInput(`${refDay}T00:00`),
    ends_at: fromLocalInput(`${nextDayIso(refDay)}T00:00`)
  });
  // ── Рисование интервалов мышью ──
  // Протяжка по свободным дням трека выделяет период и открывает форму
  // диспозиции с этими датами; перетаскивание края существующего бара
  // меняет его границы (PATCH), клик по середине — открывает правку.
  const dayIso = index => new Date(state.month.getTime() + index * 86_400_000).toISOString().slice(0, 10);
  const dayFromX = (track, clientX) => {
    const rect = track.getBoundingClientRect();
    return Math.max(0, Math.min(days - 1, Math.floor((clientX - rect.left) / dayWidth)));
  };

  container.querySelectorAll('.track[data-vehicle]').forEach(track =>
    track.addEventListener('pointerdown', event => {
      if (event.button !== 0 || event.target.closest('.dbar')) return;
      const startDay = dayFromX(track, event.clientX);
      const box = document.createElement('div');
      box.className = 'draw-select';
      track.appendChild(box);
      let lastDay = startDay;
      const paint = day => {
        const a = Math.min(startDay, day);
        const b = Math.max(startDay, day);
        box.style.left = `${a * dayWidth}px`;
        box.style.width = `${(b - a + 1) * dayWidth}px`;
      };
      paint(startDay);
      const move = ev => { lastDay = dayFromX(track, ev.clientX); paint(lastDay); };
      const up = () => {
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
        box.remove();
        const a = Math.min(startDay, lastDay);
        const b = Math.max(startDay, lastDay);
        context.openDisposition(null, {
          vehicle_id: track.dataset.vehicle,
          starts_at: fromLocalInput(`${dayIso(a)}T00:00`),
          ends_at: fromLocalInput(`${dayIso(b + 1)}T00:00`)
        });
      };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
    }));

  container.querySelectorAll('[data-disposition]').forEach(bar => {
    const item = (data.dispositions || []).find(row => row.id === bar.dataset.disposition);
    if (!item) return;
    let resizing = false;
    // Курсор-подсказка у краёв бара.
    bar.addEventListener('pointermove', event => {
      if (resizing) return;
      const rect = bar.getBoundingClientRect();
      const nearEdge = event.clientX - rect.left < 8 || rect.right - event.clientX < 8;
      bar.style.cursor = nearEdge ? 'ew-resize' : 'pointer';
    });
    bar.addEventListener('pointerdown', event => {
      const rect = bar.getBoundingClientRect();
      const edge = event.clientX - rect.left < 8 ? 'left'
        : (rect.right - event.clientX < 8 ? 'right' : null);
      if (event.button !== 0 || !edge) return;
      event.preventDefault();
      event.stopPropagation();
      resizing = true;
      const track = bar.closest('.track');
      const startIdx = Math.max(0, (Date.parse(item.starts_at) - state.month.getTime()) / 86_400_000);
      const endIdx = Math.min(days, (Date.parse(item.ends_at) - state.month.getTime()) / 86_400_000);
      let lastDay = null;
      const move = ev => {
        lastDay = dayFromX(track, ev.clientX);
        if (edge === 'left') {
          const a = Math.min(lastDay, Math.ceil(endIdx) - 1);
          bar.style.left = `${a * dayWidth}px`;
          bar.style.width = `${Math.max((endIdx - a) * dayWidth - 3, 18)}px`;
        } else {
          const b = Math.max(lastDay, Math.floor(startIdx));
          bar.style.width = `${Math.max((b + 1 - startIdx) * dayWidth - 3, 18)}px`;
        }
      };
      const up = async () => {
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
        setTimeout(() => { resizing = false; }, 0);
        if (lastDay == null) { renderResource(container, context); return; }
        try {
          const body = edge === 'left'
            ? { startsAt: fromLocalInput(`${dayIso(Math.min(lastDay, Math.ceil(endIdx) - 1))}T00:00`) }
            : { endsAt: fromLocalInput(`${dayIso(Math.max(lastDay, Math.floor(startIdx)) + 1)}T00:00`) };
          await api(`/api/dispositions/${item.id}`, { method: 'PATCH', body: JSON.stringify(body) });
          toast('Границы интервала обновлены');
          await context.onReload?.();
        } catch (error) {
          toast(error.message, 'error');
          renderResource(container, context);
        }
      };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
    });
    bar.addEventListener('click', event => {
      if (resizing) { event.stopPropagation(); return; }
      context.openDisposition(item);
    });
  });
}
