// Карта геозон с потоками ТС — перенос renderGeoMap из прототипа ТК 21.
// Зоны берутся из справочника (координаты в БД), рейсы — из /api/bootstrap.
import { escapeHtml } from './api.js';

// Грубый контур западной части РФ (широта, долгота) — схематичная подложка (ТК 21).
const RF_OUTLINE = [
  [60, 28], [62, 33], [64, 41], [66, 45], [67, 53], [66, 61], [67, 70], [68, 78], [66, 85], [62, 88],
  [57, 86], [54, 82], [52, 77], [51, 69], [52, 60], [51, 54], [50, 48], [48, 47], [46, 45], [44, 43],
  [44, 39], [45, 37], [48, 38], [50, 35], [52, 32], [55, 31], [57, 29]
];

function project(lat, lon, width, height) {
  const LON0 = 27, LON1 = 87, LAT0 = 44, LAT1 = 61, padX = 66, padY = 54;
  return [
    padX + (lon - LON0) / (LON1 - LON0) * (width - 2 * padX),
    padY + (LAT1 - lat) / (LAT1 - LAT0) * (height - 2 * padY)
  ];
}

const sameDay = (iso, dayIso) => String(iso).slice(0, 10) === dayIso;

export function zoneFlows(trips, zones, dayIso) {
  const arrivals = {}, departures = {}, flow = {};
  zones.forEach(zone => { arrivals[zone.name] = 0; departures[zone.name] = 0; });
  trips.forEach(trip => {
    if (trip.status === 'rejected') return;
    if (sameDay(trip.starts_at, dayIso)) {
      if (departures[trip.from_name] != null) departures[trip.from_name] += 1;
      if (trip.from_name !== trip.to_name) {
        const key = `${trip.from_name}|${trip.to_name}`;
        flow[key] = (flow[key] || 0) + 1;
      }
    }
    if (sameDay(trip.ends_at, dayIso) && arrivals[trip.to_name] != null) arrivals[trip.to_name] += 1;
  });
  return { arrivals, departures, flow };
}

export function renderGeoMap(data, dayIso) {
  const zones = data.reference.zones.filter(zone => zone.latitude != null && zone.longitude != null);
  const byName = Object.fromEntries(zones.map(zone => [zone.name, zone]));
  const { arrivals, departures, flow } = zoneFlows(data.trips, zones, dayIso);
  const W = 960, H = 540;
  const P = (lat, lon) => project(lat, lon, W, H);
  const outline = RF_OUTLINE.map(([lat, lon], index) => {
    const [x, y] = P(lat, lon);
    return `${index ? 'L' : 'M'}${x.toFixed(0)},${y.toFixed(0)}`;
  }).join(' ') + ' Z';

  let arrows = '';
  Object.entries(flow).sort((a, b) => b[1] - a[1]).forEach(([key, count]) => {
    const [fromName, toName] = key.split('|');
    const from = byName[fromName], to = byName[toName];
    if (!from || !to) return;
    const [x1, y1] = P(from.latitude, from.longitude);
    const [x2, y2] = P(to.latitude, to.longitude);
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    const dx = x2 - x1, dy = y2 - y1, length = Math.hypot(dx, dy) || 1;
    const offset = Math.min(55, length * 0.16);
    const cx = mx - dy / length * offset, cy = my + dx / length * offset;
    const strokeWidth = Math.min(8, 1.2 + count * 0.7);
    arrows += `<path d="M${x1.toFixed(0)},${y1.toFixed(0)} Q${cx.toFixed(0)},${cy.toFixed(0)} ${x2.toFixed(0)},${y2.toFixed(0)}"
      fill="none" stroke="${to.color}" stroke-width="${strokeWidth.toFixed(1)}" opacity="0.5"
      stroke-linecap="round" marker-end="url(#gah)"/>`;
  });

  let bubbles = '';
  zones.forEach(zone => {
    const [x, y] = P(zone.latitude, zone.longitude);
    const activity = arrivals[zone.name] + departures[zone.name];
    const radius = 15 + Math.min(24, Math.sqrt(activity) * 4.2);
    const hot = activity > 0;
    bubbles += `<g>
      ${hot ? `<circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="${(radius + 7).toFixed(0)}" fill="${zone.color}" opacity="0.18">
        <animate attributeName="opacity" values="0.28;0.08;0.28" dur="2.4s" repeatCount="indefinite"/></circle>` : ''}
      <circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="${radius.toFixed(0)}" fill="${zone.color}"
        opacity="${hot ? 0.95 : 0.5}" stroke="#fff" stroke-width="2"/>
      <text x="${x.toFixed(0)}" y="${(y - 3).toFixed(0)}" text-anchor="middle" font-size="11.5" font-weight="800" fill="#fff">${escapeHtml(zone.name)}</text>
      <text x="${x.toFixed(0)}" y="${(y + 12).toFixed(0)}" text-anchor="middle" font-size="12" font-weight="800" fill="#fff">↓${arrivals[zone.name]} ↑${departures[zone.name]}</text>
    </g>`;
  });

  const svg = `<svg viewBox="0 0 ${W} ${H}" class="geosvg" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet">
    <defs><marker id="gah" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" fill="#42566a"/></marker></defs>
    <path d="${outline}" fill="var(--soft)" stroke="var(--line)" stroke-width="1.5" opacity="0.85"/>
    ${arrows}${bubbles}</svg>`;

  const totalDepartures = Object.values(departures).reduce((a, b) => a + b, 0);
  const totalArrivals = Object.values(arrivals).reduce((a, b) => a + b, 0);
  const inMotion = Object.values(flow).reduce((a, b) => a + b, 0);
  const reference = zones.map(zone => {
    const total = data.trips.filter(trip => trip.status !== 'rejected' &&
      (trip.from_name === zone.name || trip.to_name === zone.name)).length;
    return `<tr><td style="white-space:nowrap"><span class="zsw" style="background:${zone.color}"></span> <b>${escapeHtml(zone.name)}</b></td>
      <td>${(zone.aliases || []).map(escapeHtml).join(', ')}</td>
      <td class="mono">${arrivals[zone.name]}/${departures[zone.name]}</td><td class="mono">${total}</td></tr>`;
  }).join('');

  return `<div class="geowrap">
    <div class="geomap">
      <div class="geosum">Прибытие <b class="garr">↓${totalArrivals}</b> · убытие <b class="gdep">↑${totalDepartures}</b> · рейсов в движении <b>${inMotion}</b></div>
      ${svg}
      <div class="geohint">Пузырь геозоны светится и растёт при активности; цифры — прибытие ↓ (выгрузка) и убытие ↑ (загрузка)
        на выбранный день. Стрелки — отправленные в этот день рейсы (толщина ~ количеству). Зоны расположены по реальным координатам.</div>
    </div>
    <div class="georef">
      <h4>Справочник геозон · расшифровка</h4>
      <div class="table-wrap"><table><thead><tr><th>Геозона</th><th>Города / регионы</th><th>↓/↑ день</th><th>Рейсов</th></tr></thead>
      <tbody>${reference}</tbody></table></div>
      <div class="geohint">«Рейсов» — всего с участием зоны (отправление или назначение). «↓/↑ день» — прибытие/убытие на выбранную дату.</div>
    </div>
  </div>`;
}
