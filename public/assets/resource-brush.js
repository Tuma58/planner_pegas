// Сетка-кисть для ресурса: главная работа ресурсника — расставлять
// интервалы недоступности (ремонт, пересменка, без водителя). На проде это
// 35–67 диспозиций в день, и каждая стоила формы с выбором машины, вида и
// двух полей даты-времени. Здесь то же самое делается протяжкой мыши по
// дням: выбрал состояние в палитре — покрасил нужные дни.
//
// Половина операций (48%) — правки и удаления, поэтому рядом «стереть» и
// отмена последнего действия: ошибиться не страшно.
import { api, toast } from './api.js';

export const BRUSHES = [
  { kind: 'view', label: '🖐 Просмотр', hint: 'Клик по ячейке — карточка периода', key: 'Escape' },
  { kind: 'repair', label: '🔧 Ремонт', color: '#bd8f42', key: 'r' },
  { kind: 'shift', label: '🔁 Пересменка', color: '#5e87ad', key: 'p' },
  { kind: 'no_driver', label: '👤 Без водителя', color: '#b06a55', key: 'v' },
  { kind: 'out', label: '⛔ Выведен', color: '#8f9aa6', key: 'o' },
  { kind: 'erase', label: '✕ Стереть', hint: 'Убирает интервалы в выделенных днях', key: 'Delete' }
];

const KIND_LABEL = {
  repair: 'ремонт', shift: 'пересменка', no_driver: 'без водителя',
  out: 'выведен', reserve: 'резерв', transfer: 'перегон порожним'
};

// Последнее действие для отмены: создание отменяется удалением, удаление —
// воссозданием. Один шаг назад покрывает почти все случаи промаха.
let lastAction = null;

export function brushPaletteHtml(state) {
  const active = state.resourceBrush || 'view';
  const compact = state.resourceCompact ? 'on' : '';
  return `<div class="brush-bar">
    <span class="brush-title">Кисть:</span>
    ${BRUSHES.map(brush => `<button class="brush ${brush.kind === active ? 'active' : ''}"
      data-brush="${brush.kind}" title="${brush.hint || `Клавиша ${String(brush.key).toUpperCase()}`}"
      ${brush.color ? `style="--brush-color:${brush.color}"` : ''}>${brush.label}</button>`).join('')}
    <span class="brush-sep"></span>
    <button class="brush ghost" id="brushUndo" ${lastAction ? '' : 'disabled'}
      title="Отменить последнее действие (Ctrl+Z)">↩ Отменить</button>
    <button class="brush ghost ${compact}" id="brushCompact"
      title="Плотные строки: на экран помещается вдвое больше сцепок">⇕ Компактно</button>
    <span class="brush-hint">Протяните по дням — интервал создастся сразу, без формы.
      Клавиши: R — ремонт, P — пересменка, V — без водителя, O — выведен, Del — стереть, Esc — просмотр.</span>
  </div>`;
}

const dayStartMs = iso => Date.parse(`${iso}T00:00:00Z`);

// Диспозиции, пересекающие выбранные дни: их и стираем, и на них же
// показываем, что уже занято.
const overlapping = (data, vehicleId, fromMs, toMs) => (data.dispositions || [])
  .filter(item => item.vehicle_id === vehicleId &&
    Date.parse(item.starts_at) < toMs && Date.parse(item.ends_at) > fromMs);

export function wireResourceBrush(container, context) {
  const { state } = context;
  const cells = () => [...container.querySelectorAll('[data-sched-vehicle][data-sched-day]')];
  if (!cells().length) return;

  const brushOf = () => state.resourceBrush || 'view';
  let dragging = null;

  const clearSelection = () => container.querySelectorAll('.brush-sel')
    .forEach(cell => cell.classList.remove('brush-sel'));

  const markSelection = (vehicleId, fromIso, toIso) => {
    clearSelection();
    const [a, b] = [fromIso, toIso].sort();
    cells().forEach(cell => {
      if (cell.dataset.schedVehicle !== vehicleId) return;
      const day = cell.dataset.schedDay;
      if (day >= a && day <= b) cell.classList.add('brush-sel');
    });
  };

  const applyBrush = async (vehicleId, fromIso, toIso) => {
    const [a, b] = [fromIso, toIso].sort();
    const fromMs = dayStartMs(a);
    const toMs = dayStartMs(b) + 86_400_000;
    const kind = brushOf();
    try {
      if (kind === 'erase') {
        const victims = overlapping(state.data, vehicleId, fromMs, toMs);
        if (!victims.length) { toast('В этих днях нечего стирать'); return; }
        for (const item of victims) await api(`/api/dispositions/${item.id}`, { method: 'DELETE' });
        lastAction = { type: 'delete', items: victims };
        toast(`Убрано интервалов: ${victims.length} · Ctrl+Z — вернуть`);
      } else {
        const busy = overlapping(state.data, vehicleId, fromMs, toMs);
        if (busy.length) {
          toast(`В этих днях уже есть: ${busy.map(item => KIND_LABEL[item.kind] || item.kind).join(', ')}`, 'error');
          return;
        }
        const created = await api('/api/dispositions', { method: 'POST', body: JSON.stringify({
          vehicleId, kind,
          startsAt: new Date(fromMs).toISOString(),
          endsAt: new Date(toMs).toISOString()
        }) });
        lastAction = { type: 'create', ids: [created.id] };
        const days = Math.round((toMs - fromMs) / 86_400_000);
        toast(`${KIND_LABEL[kind] || kind}: ${days} дн. · Ctrl+Z — отменить`);
      }
      await context.onReload();
    } catch (error) { toast(error.message, 'error'); }
  };

  container.addEventListener('mousedown', event => {
    const cell = event.target.closest('[data-sched-vehicle][data-sched-day]');
    if (!cell || brushOf() === 'view') return;
    event.preventDefault();
    dragging = { vehicleId: cell.dataset.schedVehicle, from: cell.dataset.schedDay, to: cell.dataset.schedDay };
    markSelection(dragging.vehicleId, dragging.from, dragging.to);
  });

  container.addEventListener('mouseover', event => {
    if (!dragging) return;
    const cell = event.target.closest('[data-sched-vehicle][data-sched-day]');
    // Тянем только по своей строке: перенос между сцепками — отдельная
    // операция, случайно «размазать» ремонт на соседей нельзя.
    if (!cell || cell.dataset.schedVehicle !== dragging.vehicleId) return;
    dragging.to = cell.dataset.schedDay;
    markSelection(dragging.vehicleId, dragging.from, dragging.to);
  });

  const finish = async () => {
    if (!dragging) return;
    const { vehicleId, from, to } = dragging;
    dragging = null;
    clearSelection();
    await applyBrush(vehicleId, from, to);
  };
  container.addEventListener('mouseup', finish);
  container.addEventListener('mouseleave', () => { dragging = null; clearSelection(); });

  container.querySelectorAll('[data-brush]').forEach(button =>
    button.addEventListener('click', () => {
      state.resourceBrush = button.dataset.brush;
      container.querySelectorAll('[data-brush]').forEach(item =>
        item.classList.toggle('active', item.dataset.brush === state.resourceBrush));
      document.body.classList.toggle('brush-on', state.resourceBrush !== 'view');
    }));

  container.querySelector('#brushCompact')?.addEventListener('click', () => {
    state.resourceCompact = !state.resourceCompact;
    document.body.classList.toggle('res-compact', Boolean(state.resourceCompact));
    container.querySelector('#brushCompact').classList.toggle('on', Boolean(state.resourceCompact));
  });

  container.querySelector('#brushUndo')?.addEventListener('click', () => undoLast(context));
}

// Отмена последнего действия: создание — удаляем, удаление — возвращаем.
export async function undoLast(context) {
  if (!lastAction) { toast('Отменять нечего'); return; }
  const action = lastAction;
  lastAction = null;
  try {
    if (action.type === 'create') {
      for (const id of action.ids) await api(`/api/dispositions/${id}`, { method: 'DELETE' });
      toast('Отменено');
    } else {
      for (const item of action.items) {
        await api('/api/dispositions', { method: 'POST', body: JSON.stringify({
          vehicleId: item.vehicle_id, kind: item.kind,
          startsAt: item.starts_at, endsAt: item.ends_at, note: item.note || '',
          addressId: item.address_id || null
        }) });
      }
      toast(`Возвращено интервалов: ${action.items.length}`);
    }
    await context.onReload();
  } catch (error) { toast(error.message, 'error'); }
}

// Клавиатура вешается один раз на документ: кисти, стирание, отмена.
let keysBound = false;
export function bindResourceKeys(getContext) {
  if (keysBound) return;
  keysBound = true;
  document.addEventListener('keydown', event => {
    const context = getContext();
    if (!context || context.state.view !== 'resource') return;
    if (document.getElementById('modalRoot')?.innerHTML.trim()) return;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      undoLast(context);
      return;
    }
    const key = event.key.toLowerCase();
    // Латиница и кириллица на одной клавише: раскладку никто не переключает.
    const byKey = { r: 'repair', к: 'repair', p: 'shift', з: 'shift', v: 'no_driver', м: 'no_driver',
      o: 'out', щ: 'out', delete: 'erase', escape: 'view' };
    const brush = byKey[key] || byKey[event.key];
    if (!brush) return;
    event.preventDefault();
    context.state.resourceBrush = brush;
    document.body.classList.toggle('brush-on', brush !== 'view');
    document.querySelectorAll('[data-brush]').forEach(item =>
      item.classList.toggle('active', item.dataset.brush === brush));
    const label = BRUSHES.find(item => item.kind === brush)?.label || brush;
    toast(`Кисть: ${label}`);
  });
}

export const hasUndo = () => Boolean(lastAction);
