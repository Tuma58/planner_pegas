// Порожний перегон: машина освободилась не там, где нужна — гоним пустой
// под погрузку, домой, в ремонт или на пересменку. Это не рейс (груза и
// выручки нет: рейс исказил бы выручку, план-факт и сверку с 1С), а вид
// диспозиции с заданием водителю и контролем прибытия. Факт прибытия
// становится местоположением сцепки для следующего назначения.
import { api, escapeHtml, formatDateTime, toast, wireSelectSearch } from './api.js';

export const TRANSFER_PURPOSES = ['под погрузку', 'на базу', 'в ремонт', 'на пересменку', 'к месту стоянки'];

// Перегоны, которые ещё не завершены: их ведёт диспетчер на контроле.
export const openTransfers = data => (data.dispositions || [])
  .filter(item => item.kind === 'transfer' && !item.arrived_at)
  .sort((a, b) => String(a.starts_at).localeCompare(String(b.starts_at)));

// Где сцепка стоит по данным перегонов: точка прибытия последнего
// завершённого перегона позже последней выгрузки — значит машина там.
export function transferPlaceOf(data, vehicleId, beforeMs = Date.now()) {
  const arrived = (data.dispositions || [])
    .filter(item => item.kind === 'transfer' && item.vehicle_id === vehicleId &&
      item.arrived_at && Date.parse(item.arrived_at) <= beforeMs)
    .sort((a, b) => String(b.arrived_at).localeCompare(String(a.arrived_at)))[0];
  return arrived ? { at: Date.parse(arrived.arrived_at), name: arrived.to_name || '',
    region: arrived.to_region || '' } : null;
}

// Текущий этап перегона: задание → в пути → прибыл.
export function transferStage(transfer) {
  if (!transfer.driver_notified_at) {
    return { key: 'task', label: '📋 задание водителю не отправлено',
      step: 'driver_notified', action: 'Задание отправлено' };
  }
  if (!transfer.departed_at) {
    return { key: 'wait', label: '⏳ ждём выезда', step: 'departed', action: 'Выехал' };
  }
  return { key: 'run', label: '🛣 в пути порожним', step: 'arrived', action: 'Прибыл' };
}

// Копируемое задание водителю — тем же порядком, что карточка рейса.
export const transferTaskText = transfer => [
  'ПЕРЕГОН ПОРОЖНИМ',
  `ТС: ${transfer.vehicle_plate}${transfer.driver_name ? ` · ${transfer.driver_name}` : ''}`,
  `Откуда: ${transfer.from_label || '—'}`,
  `Куда: ${transfer.to_name || '—'}${transfer.to_region ? ` (${transfer.to_region})` : ''}`,
  `Цель: ${transfer.purpose || '—'}`,
  `Выезд: ${formatDateTime(transfer.starts_at)}`,
  `Прибытие (расчёт): ${formatDateTime(transfer.ends_at)}`,
  transfer.empty_km ? `Расстояние: ~${Math.round(transfer.empty_km)} км порожним` : '',
  transfer.note ? `Комментарий: ${transfer.note}` : ''
].filter(Boolean).join('\n');

// Выбор сцепки для перегона: тот же поиск, что в замене ТС, — свободные
// сверху, занятые с пометкой. Нужен для входа «сначала машина, потом куда».
export function transferPickVehicleDialog(context, options = {}) {
  const data = context.state.data;
  const nowMs = Date.now();
  const rows = (data.vehicles || []).filter(vehicle => vehicle.status === 'work')
    .map(vehicle => {
      const trip = (data.trips || []).filter(item => item.vehicle_id === vehicle.id &&
        ['run', 'plan'].includes(item.status))
        .sort((a, b) => String(a.starts_at).localeCompare(String(b.starts_at)))[0];
      const transfer = (data.dispositions || []).find(item => item.kind === 'transfer' &&
        item.vehicle_id === vehicle.id && !item.arrived_at);
      const lastTrip = (data.trips || []).filter(item => item.vehicle_id === vehicle.id &&
        item.status !== 'rejected' && Date.parse(item.ends_at) <= nowMs)
        .sort((a, b) => String(b.ends_at).localeCompare(String(a.ends_at)))[0];
      const place = transfer?.arrived_at ? transfer.to_name
        : lastTrip ? (lastTrip.to_point || lastTrip.to_name) : vehicle.zone_name;
      return { vehicle, trip, transfer, place };
    })
    .sort((a, b) => Number(Boolean(a.trip || a.transfer)) - Number(Boolean(b.trip || b.transfer))
      || String(a.vehicle.plate).localeCompare(String(b.vehicle.plate)));
  context.showModal(`<h2>🚚 Перегон порожним</h2>
    <p class="muted">Выберите сцепку — дальше укажете, куда и зачем её гнать.
      Свободные показаны первыми, занятые — с текущим заданием.</p>
    <input id="transferVehicleSearch" placeholder="🔍 поиск: номер, водитель, место" autocomplete="off"
      style="width:100%;margin-bottom:8px">
    <div class="list" id="transferVehicleList" style="max-height:340px;overflow:auto">
      ${rows.map(row => `<button type="button" class="list-item" data-transfer-pick="${row.vehicle.id}"
        data-place="${escapeHtml(row.place || '')}">
        <span style="flex:1;min-width:0"><strong class="mono">${escapeHtml(row.vehicle.plate)}</strong>
          <small class="muted"> · ${escapeHtml(row.vehicle.driver_name || 'без водителя')}</small>
          <small class="muted" style="display:block">${row.transfer
    ? `🚚 уже в перегоне → ${escapeHtml(row.transfer.to_name || '')}`
    : row.trip ? `в задании: ${escapeHtml(row.trip.to_point || row.trip.to_name || '')}`
      : `стоит: ${escapeHtml(row.place || '—')}`}</small></span>
        <span class="badge ${row.trip || row.transfer ? 'warn' : 'ok'}" style="margin-left:auto">${row.transfer
    ? 'в перегоне' : row.trip ? 'занята' : 'свободна'}</span>
      </button>`).join('')}
    </div>
    <div class="modal-actions"><button type="button" class="button ghost" data-close>Отмена</button></div>`);
  const input = document.getElementById('transferVehicleSearch');
  const list = document.getElementById('transferVehicleList');
  input.addEventListener('input', () => {
    const needle = input.value.trim().toLowerCase();
    list.querySelectorAll('[data-transfer-pick]').forEach(button => {
      button.style.display = !needle || button.textContent.toLowerCase().includes(needle) ? '' : 'none';
    });
  });
  list.querySelectorAll('[data-transfer-pick]').forEach(button =>
    button.addEventListener('click', () => {
      const vehicle = (data.vehicles || []).find(item => item.id === button.dataset.transferPick);
      if (vehicle) {
        transferDialog(vehicle, data, context, { ...options, fromLabel: button.dataset.place || '' });
      }
    }));
  input.focus();
}

// Форма перегона: куда, зачем, когда выезд. Километры и расчётное время
// прибытия считает сервер — от места, где сцепка освободилась.
export function transferDialog(vehicle, data, context, options = {}) {
  const addresses = (data.reference.addresses || [])
    .filter(item => Number.isFinite(Number(item.latitude)))
    .sort((a, b) => String(a.name).localeCompare(String(b.name), 'ru'));
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  context.showModal(`<form id="transferForm">
    <h2>🚚 Перегон порожним</h2>
    <p class="muted"><span class="mono">${escapeHtml(vehicle.plate)}</span>
      · ${escapeHtml(vehicle.driver_name || 'без водителя')}
      · сейчас: ${escapeHtml(options.fromLabel || vehicle.zone_name || '—')}</p>
    <label class="field">Куда гоним
      <input id="transferSearch" placeholder="🔍 поиск пункта" autocomplete="off">
      <select name="addressId" id="transferAddress" required size="7">
        ${addresses.map(item => `<option value="${item.id}">${escapeHtml(item.name)}${item.region
    ? ` · ${escapeHtml(item.region)}` : ''}</option>`).join('')}
      </select></label>
    <label class="field">Зачем
      <select name="purpose">${TRANSFER_PURPOSES.map(item =>
    `<option${item === (options.purpose || 'под погрузку') ? ' selected' : ''}>${item}</option>`).join('')}</select></label>
    <label class="field">Выезд<input type="datetime-local" name="startsAt" value="${local}"></label>
    <label class="field">Комментарий<input name="note" maxlength="300"
      placeholder="например: забрать прицеп, поставить под погрузку 29-го"></label>
    <p class="muted">Расстояние и расчётное прибытие посчитаются сами — от места,
      где сцепка освободилась. После отметки «Прибыл» машина числится в точке
      назначения и доступна для следующего задания.</p>
    <div class="modal-actions">
      <button type="button" class="button ghost" data-close>Отмена</button>
      <button class="button">Создать перегон</button>
    </div></form>`);
  wireSelectSearch(document.getElementById('transferSearch'), document.getElementById('transferAddress'));
  document.getElementById('transferForm').onsubmit = async event => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    if (!values.addressId) { toast('Выберите точку назначения', 'error'); return; }
    try {
      const result = await api('/api/transfers', { method: 'POST', body: JSON.stringify({
        vehicleId: vehicle.id, addressId: values.addressId, purpose: values.purpose,
        startsAt: values.startsAt ? new Date(values.startsAt).toISOString() : null,
        note: values.note, fromLabel: options.fromLabel || ''
      }) });
      context.closeModal();
      toast(`Перегон создан${result.km ? `: ~${result.km} км порожним` : ''} — диспетчер получил задание`);
      await context.onReload();
    } catch (error) { toast(error.message, 'error'); }
  };
}
