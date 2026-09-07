// Вкладка «Мониторинг»: живые позиции парка из Pilot-GPS (поллер сервера,
// раз в минуту) на карте Leaflet (public/vendor, OSM-тайлы). Список слева —
// фильтры по состоянию и поиск; клик — фокус карты и карточка сцепки.
import { api, attachSearch, escapeHtml, formatDateTime } from './api.js';

const SILENT_MS = 30 * 60_000; // трекер молчит дольше получаса — тревога
// Центр/зум переживают перерисовку вкладки (тихое автообновление).
const viewState = { center: [55.7, 44.0], zoom: 5 };
let map = null;
const markerById = new Map();

const tsMs = value => {
  if (!value) return 0;
  const raw = String(value);
  return Date.parse(raw.includes('T') ? raw : raw.replace(' ', 'T') + 'Z') || 0;
};

function stateOf(item) {
  if (Date.now() - tsMs(item.fixed_at) > SILENT_MS) return 'silent';
  return Number(item.speed) >= 5 ? 'moving' : 'stopped';
}
const STATE_META = {
  moving: ['🟢', 'едет', '#2e9e5b'],
  stopped: ['🔵', 'стоит', '#4a7fb5'],
  silent: ['🔴', 'нет связи', '#c0392b']
};

export async function renderMonitoring(container, context) {
  const { state } = context;
  let items = [];
  try {
    items = (await api('/api/monitoring/positions')).items || [];
  } catch (error) {
    container.innerHTML = `<p class="muted" style="margin:20px">Мониторинг недоступен: ${escapeHtml(error.message)}.
      Проверьте логин/пароль Пилота в Настройках → Телефония и сервисы.</p>`;
    return;
  }
  // Активный рейс сцепки — для попапа и списка.
  const tripByVehicle = new Map();
  for (const trip of (state.data?.trips || [])) {
    if (trip.status === 'run') tripByVehicle.set(trip.vehicle_id, trip);
  }
  for (const item of items) {
    item.state = stateOf(item);
    item.trip = tripByVehicle.get(item.vehicle_id) || null;
    item.ageMin = Math.max(0, Math.round((Date.now() - tsMs(item.fixed_at)) / 60_000));
  }
  const query = (state.monQuery || '').toLowerCase();
  const filter = state.monFilter || '';
  const visible = items.filter(item => (!filter || item.state === filter) &&
    (!query || `${item.plate} ${item.driver_name || ''}`.toLowerCase().includes(query)));
  const counts = { moving: 0, stopped: 0, silent: 0 };
  for (const item of items) counts[item.state] += 1;

  const filterButton = (key, label) => `<button class="button small ${filter === key ? '' : 'ghost'}"
    data-mon-filter="${key}">${label} ${key ? counts[key] : items.length}</button>`;
  container.innerHTML = `<div class="mon-wrap">
    <div class="mon-list">
      <div style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:6px">
        ${filterButton('', 'Все')}${filterButton('moving', '🟢')}${filterButton('stopped', '🔵')}${filterButton('silent', '🔴')}
      </div>
      <input id="monSearch" class="block-search" placeholder="Поиск: госномер, водитель"
        value="${escapeHtml(state.monQuery || '')}" style="width:100%;margin-bottom:6px">
      <div class="list">${visible.map(item => {
        const [dot, label] = STATE_META[item.state];
        return `<div class="list-item mon-row" data-mon-focus="${item.vehicle_id}" style="cursor:pointer;padding:6px 9px">
          <span style="flex:1;min-width:0">${dot} <b class="mono">${escapeHtml(item.plate)}</b>
            <small class="muted" style="display:block">${escapeHtml((item.driver_name || '').slice(0, 28))}</small>
            <small class="muted" style="display:block">${item.state === 'moving'
              ? `${Math.round(item.speed)} км/ч` : label} · ${item.ageMin < 2 ? 'сейчас' : `${item.ageMin} мин назад`}${item.trip
              ? ` · рейс №${escapeHtml(item.trip.order_no || '—')}` : ''}</small>
          </span></div>`;
      }).join('') || '<p class="muted">Никого не найдено</p>'}</div>
    </div>
    <div id="monMap"></div>
  </div>`;

  // Карта: Leaflet из vendor; пересоздание с сохранением центра/зума.
  if (typeof L === 'undefined') {
    document.getElementById('monMap').innerHTML = '<p class="muted" style="margin:20px">Библиотека карты не загрузилась — обновите страницу.</p>';
    return;
  }
  if (map) { try { map.remove(); } catch { /* контейнер уже мёртв */ } map = null; }
  markerById.clear();
  map = L.map('monMap', { zoomControl: true }).setView(viewState.center, viewState.zoom);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18, attribution: '© OpenStreetMap'
  }).addTo(map);
  map.on('moveend', () => {
    const c = map.getCenter();
    viewState.center = [c.lat, c.lng];
    viewState.zoom = map.getZoom();
  });
  for (const item of items) {
    const [, label, color] = STATE_META[item.state];
    const marker = L.circleMarker([item.latitude, item.longitude], {
      radius: 7, color, weight: 2, fillColor: color, fillOpacity: 0.75
    }).addTo(map);
    marker.bindTooltip(item.plate, { direction: 'top', offset: [0, -6] });
    marker.bindPopup(`<div style="min-width:190px">
      <b class="mono vlink" data-vinfo="${item.vehicle_id}" style="cursor:pointer">${escapeHtml(item.plate)}</b>
      · ${label}${item.state === 'moving' ? ` ${Math.round(item.speed)} км/ч` : ''}<br>
      <small>${escapeHtml(item.driver_name || 'водитель не указан')}</small><br>
      <small class="muted">GPS: ${item.fixed_at ? formatDateTime(item.fixed_at) : '—'}</small>
      ${item.trip ? `<br><small>🚚 №${escapeHtml(item.trip.order_no || '—')}:
        ${escapeHtml((item.trip.from_point || '').slice(0, 24))} → ${escapeHtml((item.trip.to_point || '').slice(0, 24))}</small>` : ''}
    </div>`);
    markerById.set(item.vehicle_id, marker);
  }

  container.querySelectorAll('[data-mon-filter]').forEach(button =>
    button.onclick = () => {
      state.monFilter = button.dataset.monFilter;
      renderMonitoring(container, context);
    });
  container.querySelectorAll('[data-mon-focus]').forEach(row =>
    row.onclick = () => {
      const marker = markerById.get(row.dataset.monFocus);
      if (!marker) return;
      map.flyTo(marker.getLatLng(), Math.max(viewState.zoom, 11), { duration: 0.6 });
      marker.openPopup();
    });
  attachSearch(container.querySelector('#monSearch'), value => {
    state.monQuery = value;
    return renderMonitoring(container, context);
  });
}
