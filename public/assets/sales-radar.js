// «🎯 Куда продавать» — рабочий экран продаж: связка «свободная машина →
// направление → цена → клиент». Секции упорядочены по деньгам:
// 1) горящие зоны — где стоят свободные машины (с ценой простоя) и топ
//    направлений из зоны с рынком и постоянными клиентами;
// 2) дыры ближайших 72 часов — пустые слоты плана вывоза;
// 3) прайс направлений — рынок каждого регулярного плеча за 60 дней.
// Свободная машина может быть «предварительно назначена в голове логиста» —
// для этого бронь «🔒» (держится до 72 ч, видна всем, чужую снимает только
// автор или админ). Фильтры: геозона и период — применяются ко всем секциям.
import { api, escapeHtml, formatDateTime, money, toast, tripBusyUntilMs } from './api.js';

const H = 3_600_000;
const DAY_RATE = 77_000; // средняя выручка занятого машино-дня (август)

const median = list => {
  const sorted = [...list].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
};
const pct = (list, share) => {
  const sorted = [...list].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor((sorted.length - 1) * share)] : 0;
};

// Рынок направлений за 60 суток: частота, коридор ставок, ₽/км, клиенты.
export function directionMarket(data, nowMs = Date.now()) {
  const fromIso = new Date(nowMs - 60 * 86_400_000).toISOString();
  const directions = new Map();
  for (const trip of data.trips) {
    if (trip.status === 'rejected' || trip.starts_at < fromIso) continue;
    const key = `${trip.from_name}→${trip.to_name}`;
    if (!directions.has(key)) {
      directions.set(key, { key, from: trip.from_name, to: trip.to_name,
        n: 0, rates: [], km: 0, rvSum: 0, customers: new Map() });
    }
    const dir = directions.get(key);
    dir.n += 1; dir.rates.push(trip.revenue_vat);
    dir.km += trip.distance_km || 0; dir.rvSum += trip.revenue_vat;
    dir.customers.set(trip.customer_name, (dir.customers.get(trip.customer_name) || 0) + 1);
  }
  const weeks = 60 / 7;
  return [...directions.values()]
    .filter(dir => dir.n / weeks >= 1)
    .map(dir => ({
      ...dir,
      perWeek: dir.n / weeks,
      median: median(dir.rates), p25: pct(dir.rates, 0.25), p75: pct(dir.rates, 0.75),
      rubKm: dir.km ? Math.round(dir.rvSum / dir.km) : null,
      topCustomers: [...dir.customers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
    }))
    .sort((a, b) => b.rvSum - a.rvSum);
}

// Свободные машины по зонам: без активного рейса, позиция — зона последней
// выгрузки. Машины под действующей блокирующей диспозицией (ремонт, без
// водителя, пересменка, выведена) НЕ показываются — продавать их рано, их
// простой уже учтён своей причиной; резерв остаётся (использовать можно).
export function freeVehiclesByZone(data, nowMs = Date.now()) {
  const holds = new Map((data.vehicleHolds || []).map(hold => [hold.vehicle_id, hold]));
  const blocked = new Set((data.dispositions || [])
    .filter(item => item.kind !== 'reserve' &&
      Date.parse(item.starts_at) <= nowMs && Date.parse(item.ends_at) > nowMs)
    .map(item => item.vehicle_id));
  const zones = new Map();
  for (const vehicle of data.vehicles) {
    if (vehicle.status !== 'work' || blocked.has(vehicle.id)) continue;
    const trips = data.trips
      .filter(trip => trip.vehicle_id === vehicle.id && trip.status !== 'rejected')
      .sort((a, b) => a.ends_at.localeCompare(b.ends_at));
    const active = trips.find(trip => tripBusyUntilMs(trip) > nowMs ||
      ((trip.status === 'plan' || trip.status === 'run') && Date.parse(trip.starts_at) > nowMs));
    if (active) continue;
    const last = trips[trips.length - 1];
    const zone = last ? last.to_name : (vehicle.zone_name || '—');
    const idleH = last ? Math.max(0, (nowMs - tripBusyUntilMs(last)) / H) : 999;
    if (!zones.has(zone)) zones.set(zone, []);
    zones.get(zone).push({ vehicle, idleH, hold: holds.get(vehicle.id) || null });
  }
  return [...zones.entries()]
    .map(([zone, list]) => ({
      zone, list: list.sort((a, b) => b.idleH - a.idleH),
      idleDayPlus: list.filter(item => item.idleH >= 24).length,
      lossPerDay: list.filter(item => item.idleH >= 24).length * DAY_RATE
    }))
    .sort((a, b) => b.lossPerDay - a.lossPerDay || b.list.length - a.list.length);
}

const idleLabel = hours => hours >= 999 ? 'без рейсов' :
  hours >= 24 ? `стоит ${Math.floor(hours / 24)} дн` : hours >= 1 ? `стоит ${Math.floor(hours)} ч` : 'только освободилась';

export function salesRadarDialog(context) {
  const { state } = context;
  const data = state.data;
  const filter = state.radarFilter || (state.radarFilter = { zone: '', from: '', to: '' });
  const nowMs = Date.now();
  const market = directionMarket(data, nowMs);
  const zones = freeVehiclesByZone(data, nowMs)
    .filter(group => !filter.zone || group.zone === filter.zone);
  const zoneNames = [...new Set(data.reference.zones.map(zone => zone.name))];

  // Дыры 72 часа: жёлтые слоты плана вывоза в окне фильтра (по умолчанию 3 дня).
  const fromDay = filter.from || new Date(nowMs + 3 * H).toISOString().slice(0, 10);
  const toDay = filter.to || new Date(nowMs + 72 * H + 3 * H).toISOString().slice(0, 10);

  const marketFiltered = market.filter(dir =>
    !filter.zone || dir.from === filter.zone || dir.to === filter.zone);

  const zoneBlock = group => {
    const dirs = market.filter(dir => dir.from === group.zone).slice(0, 3);
    const vehiclesHtml = group.list.slice(0, 10).map(item => {
      const hold = item.hold;
      return `<span class="badge ${hold ? '' : item.idleH >= 24 ? 'bad' : 'ok'}"
        style="margin:1px;${hold ? 'opacity:.65' : ''}" data-hold-vehicle="${item.vehicle.id}"
        title="${hold
    ? `🔒 бронь: ${escapeHtml(hold.held_by_name)}${hold.note ? ` — ${escapeHtml(hold.note)}` : ''} до ${formatDateTime(hold.until)}. Клик — снять (автор или админ)`
    : `${idleLabel(item.idleH)} · клик — забронировать под сделку (по умолчанию 24 ч)`}">
        ${hold ? '🔒 ' : ''}${escapeHtml(item.vehicle.plate)}${item.idleH >= 24 && !hold ? ` · ${Math.floor(item.idleH / 24)}д` : ''}</span>`;
    }).join('') + (group.list.length > 10 ? `<span class="muted"> и ещё ${group.list.length - 10}</span>` : '');
    const dirsHtml = dirs.map(dir => `<div class="dmr-row" style="align-items:center">
      <span style="flex:1;min-width:0"><b>${escapeHtml(dir.key)}</b>
        <small class="muted" style="display:block">${dir.perWeek.toFixed(1)}/нед · рынок
          <b>${money(dir.median)}</b> (${money(dir.p25)}–${money(dir.p75)})${dir.rubKm ? ` · ${dir.rubKm} ₽/км` : ''}
          · ${dir.topCustomers.map(([name, count]) =>
    `<span class="cust-link" data-cust-card="${escapeHtml(name)}" title="Открыть CRM-карточку клиента" style="text-decoration:underline;cursor:pointer">${escapeHtml(name.slice(0, 24))}</span> (${count})`).join(', ')}</small></span>
      <button class="button small" data-fill-form="${escapeHtml(dir.from)}|${escapeHtml(dir.to)}|${dir.median}"
        title="Заполнить форму бронирования этим направлением и рыночной ставкой">→ в форму</button>
    </div>`).join('') || '<div class="muted" style="padding:4px 0">Регулярных направлений из зоны нет — спот-запрос в чат.</div>';
    return `<div class="list-item" style="display:block">
      <div style="display:flex;gap:8px;align-items:baseline;flex-wrap:wrap">
        <strong>${escapeHtml(group.zone)}</strong>
        <span class="badge ${group.idleDayPlus ? 'bad' : 'ok'}">свободно ${group.list.length}${group.idleDayPlus ? ` · сутки+ ${group.idleDayPlus}` : ''}</span>
        ${group.lossPerDay ? `<b class="danger">−${money(group.lossPerDay)}/день простоя</b>` : ''}
      </div>
      <div style="margin:4px 0">${vehiclesHtml}</div>
      ${dirsHtml}
    </div>`;
  };

  const marketRows = marketFiltered.map(dir => `<tr>
    <td><b>${escapeHtml(dir.key)}</b></td>
    <td style="text-align:right">${dir.perWeek.toFixed(1)}</td>
    <td style="text-align:right"><b>${money(dir.median)}</b></td>
    <td style="text-align:right" class="muted">${money(dir.p25)}–${money(dir.p75)}</td>
    <td style="text-align:right">${dir.rubKm ?? '—'}</td>
    <td>${dir.topCustomers.map(([name, count]) => `${escapeHtml(name.slice(0, 26))} (${count})`).join(', ')}</td>
  </tr>`).join('');

  context.showModal(`<h2>🎯 Куда продавать</h2>
    <div class="console" style="margin:8px 0;flex-wrap:wrap">
      <select id="radarZone">
        <option value="">Все геозоны</option>
        ${zoneNames.map(name => `<option ${filter.zone === name ? 'selected' : ''}>${escapeHtml(name)}</option>`).join('')}
      </select>
      <input type="date" id="radarFrom" value="${filter.from}" title="Дыры плана вывоза — с даты">
      <span class="muted">–</span>
      <input type="date" id="radarTo" value="${filter.to}" title="Дыры плана вывоза — по дату">
      ${filter.zone || filter.from || filter.to ? '<button class="button ghost small" id="radarReset">✕ Сброс</button>' : ''}
      <span class="muted" style="margin-left:auto">данные: рейсы за 60 дней · цена простоя ${money(DAY_RATE)}/машино-день</span>
    </div>
    <h3 style="margin:8px 0 6px">1 · Горящие зоны — машины ждут груз
      <small class="muted" style="text-transform:none;font-weight:400">клик по номеру — 🔒 бронь машины под сделку</small></h3>
    <div class="list" style="max-height:38vh;overflow:auto">${zones.map(zoneBlock).join('')
    || '<p class="muted">Свободных машин нет — парк загружен.</p>'}</div>
    <h3 style="margin:12px 0 6px">2 · Дыры плана вывоза <span class="badge" id="radarHolesBadge">…</span>
      <small class="muted" style="text-transform:none;font-weight:400">${fromDay.split('-').reverse().join('.')} — ${toDay.split('-').reverse().join('.')}</small></h3>
    <div class="dmr-list" id="radarHoles" style="max-height:22vh;overflow:auto"><p class="muted">Загружаю…</p></div>
    <h3 style="margin:12px 0 6px">3 · Прайс направлений <span class="badge">${marketFiltered.length}</span></h3>
    <div class="table-wrap" style="max-height:30vh;overflow:auto"><table>
      <tr><th>Направление</th><th>Рейсов/нед</th><th>Рынок (медиана)</th><th>Коридор</th><th>₽/км</th><th>Постоянные клиенты</th></tr>
      ${marketRows || '<tr><td colspan="6" class="muted">Пусто.</td></tr>'}
    </table></div>
    <div class="modal-actions"><button type="button" class="button ghost" data-close>Закрыть</button></div>`,
  'wide');

  const rerun = () => salesRadarDialog(context);
  document.getElementById('radarZone').onchange = event => { filter.zone = event.currentTarget.value; rerun(); };
  document.getElementById('radarFrom').onchange = event => { filter.from = event.currentTarget.value; rerun(); };
  document.getElementById('radarTo').onchange = event => { filter.to = event.currentTarget.value; rerun(); };
  document.getElementById('radarReset')?.addEventListener('click', () => {
    state.radarFilter = { zone: '', from: '', to: '' }; rerun();
  });

  // Бронь машины: клик по номеру — поставить (спросив пометку) или снять.
  document.querySelectorAll('[data-hold-vehicle]').forEach(badge =>
    badge.addEventListener('click', async () => {
      const vehicleId = badge.dataset.holdVehicle;
      const held = badge.textContent.includes('🔒');
      try {
        if (held) {
          await api('/api/vehicle-holds', { method: 'POST', body: JSON.stringify({ vehicleId, remove: true }) });
          toast('Бронь снята');
        } else {
          const note = prompt('Бронь на 24 часа. Пометка (клиент/сделка):', '') ?? null;
          if (note === null) return;
          await api('/api/vehicle-holds', { method: 'POST', body: JSON.stringify({ vehicleId, note, hours: 24 }) });
          toast('Машина забронирована на 24 ч — видно всем в подборе и у логиста');
        }
        await context.onReload();
        salesRadarDialog(context);
      } catch (error) { toast(error.message, 'error'); }
    }));

  // «→ в форму»: закрыть радар, заполнить зоны и ставку в форме бронирования.
  document.querySelectorAll('[data-fill-form]').forEach(button =>
    button.addEventListener('click', () => {
      const [fromName, toName, rate] = button.dataset.fillForm.split('|');
      const zoneId = name => data.reference.zones.find(zone => zone.name === name)?.id;
      context.closeModal();
      const fromSelect = document.querySelector('#salesFrom');
      const toSelect = document.querySelector('#salesTo');
      const rateInput = document.querySelector('#salesRate');
      if (!fromSelect) { toast('Откройте вкладку «Продажи» — форма бронирования там'); return; }
      if (zoneId(fromName)) fromSelect.value = zoneId(fromName);
      if (zoneId(toName)) toSelect.value = zoneId(toName);
      if (rateInput && !rateInput.value) rateInput.placeholder = Number(rate).toLocaleString('ru-RU');
      fromSelect.dispatchEvent(new Event('change', { bubbles: true }));
      document.querySelector('#salesForm')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      toast(`Форма заполнена: ${fromName} → ${toName}, рынок ${money(Number(rate))}`);
    }));

  // CRM-карточка клиента из строки направления.
  document.querySelectorAll('[data-cust-card]').forEach(link =>
    link.addEventListener('click', () => {
      import('./customer-card.js').then(module =>
        module.customerCardDialog(link.dataset.custCard, context));
    }));

  // Дыры плана вывоза: жёлтые слоты периода (без заявок).
  (async () => {
    const holes = [];
    try {
      const months = new Set([fromDay.slice(0, 7), toDay.slice(0, 7)]);
      for (const month of months) {
        const plan = await api(`/api/delivery-plan?month=${month}`);
        for (let day = 1; day <= plan.daysInMonth; day += 1) {
          const dayIso = `${month}-${String(day).padStart(2, '0')}`;
          if (dayIso < fromDay || dayIso > toDay) continue;
          const weekday = (plan.firstWeekday + day - 1) % 7;
          for (const slot of plan.slots) {
            if (slot.weekday !== weekday || slot.per_day < 0.5) continue;
            if (filter.zone && slot.from_name !== filter.zone && slot.to_name !== filter.zone) continue;
            const fact = plan.facts[`${slot.customer_name}|${slot.from_zone_id}|${slot.to_zone_id}|${day}`];
            if (fact) continue;
            holes.push({ dayIso, slot });
          }
        }
      }
    } catch { /* план вывоза недоступен — секция останется пустой */ }
    holes.sort((a, b) => a.dayIso.localeCompare(b.dayIso));
    const badge = document.getElementById('radarHolesBadge');
    const box = document.getElementById('radarHoles');
    if (!box) return;
    if (badge) badge.textContent = holes.length;
    box.innerHTML = holes.slice(0, 40).map(({ dayIso, slot }) => `<div class="dmr-row">
      <span style="flex:1;min-width:0"><b>${dayIso.split('-').reverse().slice(0, 2).join('.')}</b>
        · ${escapeHtml(slot.customer_name)} · ${escapeHtml(slot.from_name)}→${escapeHtml(slot.to_name)}
        <small class="muted" style="display:block">слот ${Math.round(slot.per_day * 10) / 10}/день · ставка ${money(slot.rate)} — заявки нет, позвоните клиенту</small></span>
      <span class="cust-link" data-hole-cust="${escapeHtml(slot.customer_name)}"
        style="text-decoration:underline;cursor:pointer" title="CRM-карточка">📇</span>
    </div>`).join('') || '<p class="muted">Дыр нет — все слоты периода закрыты заявками.</p>';
    box.querySelectorAll('[data-hole-cust]').forEach(link =>
      link.addEventListener('click', () => {
        import('./customer-card.js').then(module =>
          module.customerCardDialog(link.dataset.holeCust, context));
      }));
  })();
}
