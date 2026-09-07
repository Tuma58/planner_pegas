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

// Выжимка датчиков из сырого sensors_json: ищем по имени — состав у
// разных трекеров разный, имена стабильны («Датчик температуры 1», «Двери»).
function parseSensors(raw) {
  try { return JSON.parse(raw || '[]'); } catch { return []; }
}
const sensorByName = (sensors, pattern) => sensors.find(s => pattern.test(String(s.name || '')));
function truckSummary(item) {
  const sensors = parseSensors(item.sensors_json);
  const engine = sensorByName(sensors, /двигатель can|^двигатель$/i) || sensorByName(sensors, /ignition/i);
  const fuel = sensorByName(sensors, /расход топлива/i);
  const mileage = sensorByName(sensors, /пробег по can/i);
  const rpm = sensorByName(sensors, /обороты/i);
  return { engine, fuel, mileage, rpm };
}
function trailerSummary(item) {
  const sensors = parseSensors(item.trailer_sensors_json);
  const door = sensorByName(sensors, /двер/i);
  const tAvg = sensorByName(sensors, /средняя температура/i);
  const t1 = sensorByName(sensors, /температуры 1/i);
  const t2 = sensorByName(sensors, /температуры 2/i);
  const gen = sensorByName(sensors, /генератор/i);
  return { door, tAvg, t1, t2, gen };
}

export async function renderMonitoring(container, context) {
  const { state } = context;
  let items = [];
  let trailers = [];
  try {
    const answer = await api('/api/monitoring/positions');
    items = answer.items || [];
    trailers = answer.trailers || [];
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
    (!query || `${item.plate} ${item.driver_name || ''} ${item.trailer_number || ''}`.toLowerCase().includes(query)));
  const counts = { moving: 0, stopped: 0, silent: 0 };
  for (const item of items) counts[item.state] += 1;

  const filterButton = (key, label) => `<button class="button small ${filter === key ? '' : 'ghost'}"
    data-mon-filter="${key}">${label} ${key ? counts[key] : items.length}</button>`;
  container.innerHTML = `<div class="mon-wrap">
    <div class="mon-list">
      <div style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:6px">
        ${filterButton('', 'Все')}${filterButton('moving', '🟢')}${filterButton('stopped', '🔵')}${filterButton('silent', '🔴')}
        <button class="button small ${state.monTrailers ? '' : 'ghost'}" id="monTrailersToggle"
          title="Показать прицепы отдельными маркерами: свободные, отцепленные, температуры и двери">▢ Прицепы ${trailers.filter(t => t.latitude).length}</button>
      </div>
      <input id="monSearch" class="block-search" placeholder="Поиск: госномер, водитель"
        value="${escapeHtml(state.monQuery || '')}" style="width:100%;margin-bottom:6px">
      <div class="list">${visible.map(item => {
        const [dot, label] = STATE_META[item.state];
        return `<div class="list-item mon-row" data-mon-focus="${item.vehicle_id}" style="cursor:pointer;padding:6px 9px">
          <span style="flex:1;min-width:0">${dot} <b class="mono">${escapeHtml(item.plate)}</b>
            ${item.trailer_number ? `<small class="muted" style="display:block;margin-left:18px">▢ ${escapeHtml(item.trailer_number)}</small>` : ''}
            <small class="muted" style="display:block">${escapeHtml((item.driver_name || '').slice(0, 28))}</small>
            <small class="muted" style="display:block">${item.state === 'moving'
              ? `${Math.round(item.speed)} км/ч` : label} · ${item.ageMin < 2 ? 'сейчас' : `${item.ageMin} мин назад`}${item.trip
              ? ` · рейс №${escapeHtml(item.trip.order_no || '—')}` : ''}</small>
            ${(() => { const tr = trailerSummary(item);
              return (tr.tAvg || tr.door) ? `<small style="display:block">${tr.tAvg
                ? `🌡 ${escapeHtml(tr.tAvg.value)}` : ''}${tr.door
                ? ` · 🚪 ${escapeHtml(String(tr.door.value).toLowerCase())}` : ''}</small>` : ''; })()}
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
    const trailerInfo = trailerSummary(item);
    marker.bindTooltip(`${item.plate}${trailerInfo.tAvg ? ` · 🌡${trailerInfo.tAvg.value}` : ''}${trailerInfo.door
      ? ` · 🚪${String(trailerInfo.door.value).toLowerCase()}` : ''}`,
    { direction: 'top', offset: [0, -6] });
    marker.bindPopup(`<div style="min-width:190px">
      <b class="mono vlink" data-vinfo="${item.vehicle_id}" style="cursor:pointer">${escapeHtml(item.plate)}</b>
      · ${label}${item.state === 'moving' ? ` ${Math.round(item.speed)} км/ч` : ''}<br>
      <small>${escapeHtml(item.driver_name || 'водитель не указан')}</small><br>
      <small class="muted">GPS: ${item.fixed_at ? formatDateTime(item.fixed_at) : '—'}</small>
      ${item.trip ? `<br><small>🚚 №${escapeHtml(item.trip.order_no || '—')}:
        ${escapeHtml((item.trip.from_point || '').slice(0, 24))} → ${escapeHtml((item.trip.to_point || '').slice(0, 24))}</small>` : ''}
      ${(() => { const t = truckSummary(item);
        const parts = [t.engine && `двигатель ${escapeHtml(String(t.engine.value).toLowerCase())}`,
          t.rpm && Number(t.rpm.dig) > 0 && `${escapeHtml(t.rpm.value)}`,
          t.fuel && `⛽ ${escapeHtml(t.fuel.value)}`,
          t.mileage && `одометр ${escapeHtml(t.mileage.value)}`].filter(Boolean);
        return parts.length ? `<br><small class="muted">Тягач: ${parts.join(' · ')}</small>` : ''; })()}
      ${(() => { const tr = trailerSummary(item);
        if (!tr.door && !tr.tAvg && !tr.t1) return item.trailer_number
          ? `<br><small class="muted">Прицеп ${escapeHtml(item.trailer_number)}: датчики не отвечают</small>` : '';
        const temps = [tr.t1 && `t1 ${escapeHtml(tr.t1.value)}`, tr.t2 && `t2 ${escapeHtml(tr.t2.value)}`]
          .filter(Boolean).join(', ');
        return `<br><small><b>Прицеп ${escapeHtml(item.trailer_number || '')}</b>:
          ${tr.tAvg ? `🌡 <b>${escapeHtml(tr.tAvg.value)}</b>${temps ? ` (${temps})` : ''}` : ''}
          ${tr.door ? ` · 🚪 ${escapeHtml(String(tr.door.value).toLowerCase())}` : ''}
          ${tr.gen ? ` · генератор ${escapeHtml(String(tr.gen.value).toLowerCase())}` : ''}</small>`; })()}
    </div>`);
    markerById.set(item.vehicle_id, marker);
  }

  // Слой прицепов: квадратные маркеры. Прицеп в 1+ км от своего тягача —
  // «отдельно от тягача» (отцеплен); без сцепки — «свободный».
  if (state.monTrailers) {
    const truckPos = new Map(items.map(item => [item.vehicle_id, item]));
    const distKm = (a, b, c, d) => {
      const rad = Math.PI / 180;
      const x = (c - a) * rad, y = (d - b) * rad * Math.cos((a + c) / 2 * rad);
      return Math.sqrt(x * x + y * y) * 6371;
    };
    for (const trailer of trailers) {
      if (!Number.isFinite(trailer.latitude) || !trailer.latitude) continue;
      const owner = trailer.vehicle_id ? truckPos.get(trailer.vehicle_id) : null;
      const away = owner && Number.isFinite(owner.latitude)
        ? distKm(trailer.latitude, trailer.longitude, owner.latitude, owner.longitude) : null;
      const detached = away != null && away > 1;
      const info = trailerSummary({ trailer_sensors_json: trailer.sensors_json });
      const color = !trailer.vehicle_id ? '#8e44ad' : detached ? '#e67e22' : '#7f8c8d';
      const marker = L.marker([trailer.latitude, trailer.longitude], {
        icon: L.divIcon({ className: '', iconSize: [12, 12],
          html: `<div style="width:11px;height:11px;background:${color};border:2px solid #fff;border-radius:2px;box-shadow:0 0 3px rgba(0,0,0,.5)"></div>` })
      }).addTo(map);
      marker.bindTooltip(`▢ ${trailer.number}${info.tAvg ? ` · 🌡${info.tAvg.value}` : ''}${info.door
        ? ` · 🚪${String(info.door.value).toLowerCase()}` : ''}`, { direction: 'top', offset: [0, -8] });
      marker.bindPopup(`<div style="min-width:170px">
        <b>▢ Прицеп ${escapeHtml(trailer.number)}</b><br>
        <small>${!trailer.vehicle_id ? '🟣 свободный (нет в сцепках)'
          : detached ? `🟠 отдельно от тягача ${escapeHtml(trailer.owner_plate || '')} (${Math.round(away)} км)`
          : `в сцепке с ${escapeHtml(trailer.owner_plate || '')}`}</small><br>
        ${info.tAvg ? `<small>🌡 <b>${escapeHtml(info.tAvg.value)}</b>${info.t1 ? ` (t1 ${escapeHtml(info.t1.value)}${info.t2 ? `, t2 ${escapeHtml(info.t2.value)}` : ''})` : ''}</small><br>` : ''}
        ${info.door ? `<small>🚪 двери ${escapeHtml(String(info.door.value).toLowerCase())}</small><br>` : ''}
        <small class="muted">GPS: ${trailer.fixed_at ? formatDateTime(trailer.fixed_at) : '—'}</small>
      </div>`);
    }
  }
  const trailersToggle = container.querySelector('#monTrailersToggle');
  if (trailersToggle) trailersToggle.onclick = () => {
    state.monTrailers = !state.monTrailers;
    renderMonitoring(container, context);
  };
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
