// Вкладка «Мониторинг»: живые позиции парка из Pilot-GPS (поллер сервера,
// раз в минуту) на карте Leaflet (public/vendor, OSM-тайлы).
// Карта создаётся ОДИН раз и живёт между тихими автообновлениями: маркеры
// двигаются setLatLng, попапы и полёт камеры не сбрасываются; перерисовка
// целиком — только когда DOM карты реально умер (уход с вкладки и назад).
import { api, attachSearch, escapeHtml, formatDateTime } from './api.js';

const SILENT_MS = 30 * 60_000; // трекер молчит дольше получаса — тревога
const viewState = { center: [55.7, 44.0], zoom: 5 };
let map = null;
const truckMarkers = new Map();   // vehicle_id → marker
const trailerMarkers = new Map(); // imei → marker

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
  return {
    engine: sensorByName(sensors, /двигатель can|^двигатель$/i) || sensorByName(sensors, /ignition/i),
    fuel: sensorByName(sensors, /расход топлива/i),
    mileage: sensorByName(sensors, /пробег по can/i),
    rpm: sensorByName(sensors, /обороты/i)
  };
}
function trailerSummary(raw) {
  const sensors = parseSensors(raw);
  return {
    door: sensorByName(sensors, /двер/i),
    tAvg: sensorByName(sensors, /средняя температура/i),
    t1: sensorByName(sensors, /температуры 1/i),
    t2: sensorByName(sensors, /температуры 2/i),
    gen: sensorByName(sensors, /генератор/i)
  };
}

const distKm = (a, b, c, d) => {
  const rad = Math.PI / 180;
  const x = (c - a) * rad, y = (d - b) * rad * Math.cos((a + c) / 2 * rad);
  return Math.sqrt(x * x + y * y) * 6371;
};

function truckPopupHtml(item) {
  const [, label] = STATE_META[item.state];
  const t = truckSummary(item);
  const truckParts = [t.engine && `двигатель ${escapeHtml(String(t.engine.value).toLowerCase())}`,
    t.rpm && Number(t.rpm.dig) > 0 && `${escapeHtml(t.rpm.value)}`,
    t.fuel && `⛽ ${escapeHtml(t.fuel.value)}`,
    t.mileage && `одометр ${escapeHtml(t.mileage.value)}`].filter(Boolean);
  const tr = trailerSummary(item.trailer_sensors_json);
  const temps = [tr.t1 && `t1 ${escapeHtml(tr.t1.value)}`, tr.t2 && `t2 ${escapeHtml(tr.t2.value)}`]
    .filter(Boolean).join(', ');
  return `<div style="min-width:190px">
    <b class="mono vlink" data-vinfo="${item.vehicle_id}" style="cursor:pointer">${escapeHtml(item.plate)}</b>
    · ${label}${item.state === 'moving' ? ` ${Math.round(item.speed)} км/ч` : ''}<br>
    <small>${escapeHtml(item.driver_name || 'водитель не указан')}</small><br>
    <small class="muted">GPS: ${item.fixed_at ? formatDateTime(item.fixed_at) : '—'}</small>
    ${item.trip ? `<br><small>🚚 №${escapeHtml(item.trip.order_no || '—')}:
      ${escapeHtml((item.trip.from_point || '').slice(0, 24))} → ${escapeHtml((item.trip.to_point || '').slice(0, 24))}</small>` : ''}
    ${truckParts.length ? `<br><small class="muted">Тягач: ${truckParts.join(' · ')}</small>` : ''}
    ${(tr.door || tr.tAvg || tr.t1) ? `<br><small><b>Прицеп ${escapeHtml(item.trailer_number || '')}</b>:
      ${tr.tAvg ? `🌡 <b>${escapeHtml(tr.tAvg.value)}</b>${temps ? ` (${temps})` : ''}` : ''}
      ${tr.door ? ` · 🚪 ${escapeHtml(String(tr.door.value).toLowerCase())}` : ''}
      ${tr.gen ? ` · генератор ${escapeHtml(String(tr.gen.value).toLowerCase())}` : ''}</small>`
    : item.trailer_number ? `<br><small class="muted">Прицеп ${escapeHtml(item.trailer_number)}: датчики не отвечают</small>` : ''}
  </div>`;
}

function trailerPopupHtml(trailer, owner) {
  const info = trailerSummary(trailer.sensors_json);
  const away = owner && Number.isFinite(owner.latitude) && Number.isFinite(trailer.latitude)
    ? distKm(trailer.latitude, trailer.longitude, owner.latitude, owner.longitude) : null;
  const detached = away != null && away > 1;
  return `<div style="min-width:170px">
    <b>▢ Прицеп ${escapeHtml(trailer.number)}</b><br>
    <small>${!trailer.vehicle_id ? '🟣 свободный (нет в сцепках)'
      : detached ? `🟠 отдельно от тягача ${escapeHtml(trailer.owner_plate || '')} (${Math.round(away)} км)`
      : `в сцепке с ${escapeHtml(trailer.owner_plate || '')}`}</small><br>
    ${info.tAvg ? `<small>🌡 <b>${escapeHtml(info.tAvg.value)}</b>${info.t1 ? ` (t1 ${escapeHtml(info.t1.value)}${info.t2 ? `, t2 ${escapeHtml(info.t2.value)}` : ''})` : ''}</small><br>` : ''}
    ${info.door ? `<small>🚪 двери ${escapeHtml(String(info.door.value).toLowerCase())}</small><br>` : ''}
    <small class="muted">GPS: ${trailer.fixed_at ? formatDateTime(trailer.fixed_at) : '—'}</small>
  </div>`;
}

// Глиф маркера: едет — стрелка, повёрнутая по курсу GPS; стоит — кружок
// с точкой; нет связи — тусклый с крестом. Плашка с госномером — под
// глифом, показывается при приближении (класс mon-zoomed на карте).
function truckGlyphHtml(item) {
  const dir = Number(item.direction) || 0;
  if (item.state === 'moving') {
    return `<div class="mon-glyph" style="transform:rotate(${dir}deg)">
      <svg viewBox="0 0 24 24" width="26" height="26"><path d="M12 2 L20 21 L12 16.5 L4 21 Z"
        fill="#1f9d55" stroke="#fff" stroke-width="1.6"/></svg></div>`;
  }
  if (item.state === 'stopped') {
    return `<div class="mon-glyph"><svg viewBox="0 0 24 24" width="20" height="20">
      <circle cx="12" cy="12" r="9" fill="#3f7fc2" stroke="#fff" stroke-width="2"/>
      <circle cx="12" cy="12" r="3" fill="#fff"/></svg></div>`;
  }
  return `<div class="mon-glyph" style="opacity:.75"><svg viewBox="0 0 24 24" width="20" height="20">
    <circle cx="12" cy="12" r="9" fill="#9aa0a6" stroke="#fff" stroke-width="2"/>
    <path d="M8.5 8.5 L15.5 15.5 M15.5 8.5 L8.5 15.5" stroke="#fff" stroke-width="2"/></svg></div>`;
}
function truckIcon(item) {
  return L.divIcon({ className: 'mon-marker-anim', iconSize: [26, 26], iconAnchor: [13, 13],
    html: `<div class="mon-veh">${truckGlyphHtml(item)}
      <div class="mon-plate">${escapeHtml(item.plate)}</div></div>` });
}
// Обновление/создание маркера без пересоздания: позиция плавно едет по
// CSS-transition, глиф/поворот обновляются точечно, попапы не сбрасываются.
function upsertTruckMarker(item) {
  const tr = trailerSummary(item.trailer_sensors_json);
  const tooltip = `${item.plate}${tr.tAvg ? ` · 🌡${tr.tAvg.value}` : ''}${tr.door
    ? ` · 🚪${String(tr.door.value).toLowerCase()}` : ''}`;
  let marker = truckMarkers.get(item.vehicle_id);
  if (!marker) {
    marker = L.marker([item.latitude, item.longitude], { icon: truckIcon(item) }).addTo(map);
    marker.bindTooltip(tooltip, { direction: 'top', offset: [0, -14] });
    marker.bindPopup(truckPopupHtml(item));
    marker._monState = item.state;
    marker._monDir = Number(item.direction) || 0;
    truckMarkers.set(item.vehicle_id, marker);
    return;
  }
  marker.setLatLng([item.latitude, item.longitude]);
  const dir = Number(item.direction) || 0;
  if (marker._monState !== item.state) {
    marker.setIcon(truckIcon(item));
    marker._monState = item.state;
    marker._monDir = dir;
  } else if (Math.abs(dir - marker._monDir) > 5) {
    const glyph = marker.getElement()?.querySelector('.mon-glyph');
    if (glyph && item.state === 'moving') glyph.style.transform = `rotate(${dir}deg)`;
    marker._monDir = dir;
  }
  marker.setTooltipContent(tooltip);
  marker.setPopupContent(truckPopupHtml(item));
}

function upsertTrailerMarker(trailer, owner) {
  const away = owner && Number.isFinite(owner.latitude) && Number.isFinite(trailer.latitude)
    ? distKm(trailer.latitude, trailer.longitude, owner.latitude, owner.longitude) : null;
  const detached = away != null && away > 1;
  const color = !trailer.vehicle_id ? '#8e44ad' : detached ? '#e67e22' : '#7f8c8d';
  const info = trailerSummary(trailer.sensors_json);
  const tooltip = `▢ ${trailer.number}${info.tAvg ? ` · 🌡${info.tAvg.value}` : ''}${info.door
    ? ` · 🚪${String(info.door.value).toLowerCase()}` : ''}`;
  const icon = L.divIcon({ className: 'mon-marker-anim', iconSize: [12, 12], iconAnchor: [6, 6],
    html: `<div class="mon-veh"><div style="width:11px;height:11px;background:${color};border:2px solid #fff;border-radius:2px;box-shadow:0 0 3px rgba(0,0,0,.5)"></div>
      <div class="mon-plate">${escapeHtml(trailer.number)}</div></div>` });
  let marker = trailerMarkers.get(trailer.imei);
  if (!marker) {
    marker = L.marker([trailer.latitude, trailer.longitude], { icon }).addTo(map);
    marker.bindTooltip(tooltip, { direction: 'top', offset: [0, -8] });
    marker.bindPopup(trailerPopupHtml(trailer, owner));
    trailerMarkers.set(trailer.imei, marker);
    return;
  }
  marker.setLatLng([trailer.latitude, trailer.longitude]);
  marker.setIcon(icon);
  marker.setTooltipContent(tooltip);
  marker.setPopupContent(trailerPopupHtml(trailer, owner));
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
    map = null; truckMarkers.clear(); trailerMarkers.clear();
    return;
  }
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

  // ── Каркас: создаётся один раз; дальше обновляется только список. ──
  const mapNode = container.querySelector('#monMap');
  const alive = map && mapNode && map.getContainer() === mapNode;
  if (!alive) {
    container.innerHTML = `<div class="mon-wrap">
      <div class="mon-list"><div id="monListBody"></div></div>
      <div id="monMap"></div>
    </div>`;
    truckMarkers.clear();
    trailerMarkers.clear();
    if (typeof L === 'undefined') {
      container.querySelector('#monMap').innerHTML =
        '<p class="muted" style="margin:20px">Библиотека карты не загрузилась — обновите страницу.</p>';
      return;
    }
    if (map) { try { map.remove(); } catch { /* прежний контейнер мёртв */ } }
    map = L.map(container.querySelector('#monMap'), { zoomControl: true })
      .setView(viewState.center, viewState.zoom);
    // Убираем префикс «Leaflet» с флагом из атрибуции; «© OpenStreetMap»
    // остаётся — обязательная подпись по лицензии данных карты.
    map.attributionControl.setPrefix(false);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18, attribution: '© OpenStreetMap'
    }).addTo(map);
    map.on('moveend', () => {
      const c = map.getCenter();
      viewState.center = [c.lat, c.lng];
      viewState.zoom = map.getZoom();
    });
    const syncZoomClass = () => map.getContainer().classList.toggle('mon-zoomed', map.getZoom() >= 9);
    map.on('zoomend', syncZoomClass);
    syncZoomClass();
  }

  // ── Список: перерисовывается каждый раз (лёгкий), карта не трогается. ──
  const filterButton = (key, label) => `<button class="button small ${filter === key ? '' : 'ghost'}"
    data-mon-filter="${key}">${label} ${key ? counts[key] : items.length}</button>`;
  container.querySelector('#monListBody').innerHTML = `
    <div style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:6px">
      ${filterButton('', 'Все')}${filterButton('moving', '🟢')}${filterButton('stopped', '🔵')}${filterButton('silent', '🔴')}
      <button class="button small ${state.monTrailers ? '' : 'ghost'}" id="monTrailersToggle"
        title="Показать прицепы отдельными маркерами: свободные, отцепленные, температуры и двери">▢ Прицепы ${trailers.filter(t => t.latitude).length}</button>
    </div>
    <input id="monSearch" class="block-search" placeholder="Поиск: госномер, водитель, прицеп"
      value="${escapeHtml(state.monQuery || '')}" style="width:100%;margin-bottom:6px">
    <div class="list">${visible.map(item => {
      const [dot, label] = STATE_META[item.state];
      const tr = trailerSummary(item.trailer_sensors_json);
      return `<div class="list-item mon-row" data-mon-focus="${item.vehicle_id}" style="cursor:pointer;padding:6px 9px">
        <span style="flex:1;min-width:0">${dot} <b class="mono">${escapeHtml(item.plate)}</b>
          ${item.trailer_number ? `<small class="muted" style="display:block;margin-left:18px">▢ ${escapeHtml(item.trailer_number)}</small>` : ''}
          <small class="muted" style="display:block">${escapeHtml((item.driver_name || '').slice(0, 28))}</small>
          <small class="muted" style="display:block">${item.state === 'moving'
            ? `${Math.round(item.speed)} км/ч` : label} · ${item.ageMin < 2 ? 'сейчас' : `${item.ageMin} мин назад`}${item.trip
            ? ` · рейс №${escapeHtml(item.trip.order_no || '—')}` : ''}</small>
          ${(tr.tAvg || tr.door) ? `<small style="display:block">${tr.tAvg
            ? `🌡 ${escapeHtml(tr.tAvg.value)}` : ''}${tr.door
            ? ` · 🚪 ${escapeHtml(String(tr.door.value).toLowerCase())}` : ''}</small>` : ''}
        </span></div>`;
    }).join('') || '<p class="muted">Никого не найдено</p>'}</div>`;

  // ── Маркеры: upsert без пересоздания, исчезнувшие убираются. ──
  if (typeof L === 'undefined' || !map) return;
  const seenTrucks = new Set();
  for (const item of items) {
    if (!Number.isFinite(item.latitude) || !item.latitude) continue;
    upsertTruckMarker(item);
    seenTrucks.add(item.vehicle_id);
  }
  for (const [id, marker] of truckMarkers) {
    if (!seenTrucks.has(id)) { marker.remove(); truckMarkers.delete(id); }
  }
  const truckById = new Map(items.map(item => [item.vehicle_id, item]));
  const seenTrailers = new Set();
  if (state.monTrailers) {
    for (const trailer of trailers) {
      if (!Number.isFinite(trailer.latitude) || !trailer.latitude) continue;
      upsertTrailerMarker(trailer, trailer.vehicle_id ? truckById.get(trailer.vehicle_id) : null);
      seenTrailers.add(trailer.imei);
    }
  }
  for (const [imei, marker] of trailerMarkers) {
    if (!seenTrailers.has(imei)) { marker.remove(); trailerMarkers.delete(imei); }
  }

  // ── Обработчики списка (перевешиваются с его перерисовкой). ──
  container.querySelector('#monTrailersToggle').onclick = () => {
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
      const marker = truckMarkers.get(row.dataset.monFocus);
      if (!marker) return;
      map.flyTo(marker.getLatLng(), Math.max(map.getZoom(), 11), { duration: 0.6 });
      marker.openPopup();
    });
  attachSearch(container.querySelector('#monSearch'), value => {
    state.monQuery = value;
    return renderMonitoring(container, context);
  });
}
