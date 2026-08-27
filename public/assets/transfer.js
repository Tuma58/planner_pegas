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
