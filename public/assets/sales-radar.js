// «🎯 Куда продавать» — рабочий экран продаж: связка «свободная машина →
// направление → цена → клиент». Секции упорядочены по деньгам:
// 1) горящие зоны — где стоят свободные машины (с ценой простоя) и топ
//    направлений из зоны с рынком и постоянными клиентами;
// 2) дыры ближайшего периода — пустые слоты плана вывоза;
// 3) прайс направлений — рынок каждого регулярного плеча за 60 дней.
// Свободная машина может быть «предварительно назначена в голове логиста» —
// для этого бронь «🔒» (до 72 ч, видна всем, чужую снимает автор или админ).
// Ёмкость зоны честная: «свободно N · без брони M», потери — только по
// незабронированным. Фильтры — ЧИПЫ зон и пресеты периода: тяжёлые данные
// считаются один раз при открытии, клик по чипу перерисовывает только
// секции — без сети и пересчёта (иначе фильтр лагал).
import { api, escapeHtml, formatDateTime, money, toast, tripBusyUntilMs } from './api.js';
import { vehiclePlace } from './transfer.js';

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
    // Прибытие перегона переставляет машину: после перегона она свободна
    // уже в новой зоне, а не там, где выгрузилась.
    const place = vehiclePlace(data, vehicle.id, nowMs);
    const zone = place.zoneName || (last ? last.to_name : (vehicle.zone_name || '—'));
    const idleH = last ? Math.max(0, (nowMs - tripBusyUntilMs(last)) / H) : 999;
    if (!zones.has(zone)) zones.set(zone, []);
    zones.get(zone).push({ vehicle, idleH, hold: holds.get(vehicle.id) || null });
  }
  return [...zones.entries()]
    .map(([zone, list]) => {
      const noHold = list.filter(item => !item.hold);
      return {
        zone, list: list.sort((a, b) => b.idleH - a.idleH),
        freeNoHold: noHold.length,
        idleDayPlus: noHold.filter(item => item.idleH >= 24).length,
        lossPerDay: noHold.filter(item => item.idleH >= 24).length * DAY_RATE
      };
    })
    .sort((a, b) => b.lossPerDay - a.lossPerDay || b.freeNoHold - a.freeNoHold);
}

const idleLabel = hours => hours >= 999 ? 'без рейсов' :
  hours >= 24 ? `стоит ${Math.floor(hours / 24)} дн` : hours >= 1 ? `стоит ${Math.floor(hours)} ч` : 'только освободилась';

export function salesRadarDialog(context) {
  const { state } = context;
  const data = state.data;
  const filter = state.radarFilter || (state.radarFilter = { zone: '', preset: '72h' });
  const nowMs = Date.now();

  // Тяжёлые данные считаются ОДИН РАЗ при открытии; фильтры лишь перерисовывают
  // секции из готовых структур. Брони обновляются локально после ответа API.
  const market = directionMarket(data, nowMs);
  let zonesAll = freeVehiclesByZone(data, nowMs);
  let holesAll = null; // грузится фоном один раз (план вывоза текущего+следующего месяца)

  const presetDays = { '72h': 3, '7d': 7, '14d': 14 };

  context.showModal(`<h2>🎯 Куда продавать</h2>
    <div id="radarChips" style="display:flex;gap:4px;flex-wrap:wrap;margin:8px 0"></div>
    <div class="console" style="margin:0 0 8px">
      <span class="cnl">Дыры плана:</span>
      ${Object.entries({ '72h': '72 часа', '7d': 'неделя', '14d': '2 недели' }).map(([key, label]) =>
    `<button type="button" class="button ghost small" data-preset="${key}">${label}</button>`).join('')}
      <span class="muted" style="margin-left:auto">рынок за 60 дней · простой ${money(DAY_RATE)}/машино-день</span>
    </div>
    <h3 style="margin:8px 0 6px">1 · Горящие зоны — машины ждут груз
      <small class="muted" style="text-transform:none;font-weight:400">клик по номеру — 🔒 бронь под сделку</small></h3>
    <div class="list" id="radarZones" style="max-height:36vh;overflow:auto"></div>
    <h3 style="margin:12px 0 6px">2 · Дыры плана вывоза <span class="badge" id="radarHolesBadge">…</span></h3>
    <div class="dmr-list" id="radarHoles" style="max-height:22vh;overflow:auto"><p class="muted">Загружаю…</p></div>
    <h3 style="margin:12px 0 6px">3 · Прайс направлений <span class="badge" id="radarMarketBadge"></span></h3>
    <div class="table-wrap" id="radarMarket" style="max-height:30vh;overflow:auto"></div>
    <div class="modal-actions"><button type="button" class="button ghost" data-close>Закрыть</button></div>`,
  'wide');

  const zoneBlockHtml = group => {
    const dirs = market.filter(dir => dir.from === group.zone).slice(0, 3);
    const vehiclesHtml = group.list.slice(0, 12).map(item => {
      const hold = item.hold;
      return `<span class="badge ${hold ? '' : item.idleH >= 24 ? 'bad' : 'ok'}"
        style="margin:1px;cursor:pointer;${hold ? 'opacity:.6' : ''}" data-hold-vehicle="${item.vehicle.id}"
        title="${hold
    ? `🔒 бронь: ${escapeHtml(hold.held_by_name)}${hold.note ? ` — ${escapeHtml(hold.note)}` : ''} до ${formatDateTime(hold.until)}. Клик — снять (автор или админ)`
    : `${idleLabel(item.idleH)} · клик — забронировать под сделку (24 ч)`}">
        ${hold ? '🔒 ' : ''}${escapeHtml(item.vehicle.plate)}${item.idleH >= 24 && !hold ? ` · ${Math.floor(item.idleH / 24)}д` : ''}</span>`;
    }).join('') + (group.list.length > 12 ? `<span class="muted"> и ещё ${group.list.length - 12}</span>` : '');
    const dirsHtml = dirs.map(dir => `<div class="dmr-row" style="align-items:center">
      <span style="flex:1;min-width:0"><b>${escapeHtml(dir.key)}</b>
        <small class="muted" style="display:block">${dir.perWeek.toFixed(1)}/нед · рынок
          <b>${money(dir.median)}</b> (${money(dir.p25)}–${money(dir.p75)})${dir.rubKm ? ` · ${dir.rubKm} ₽/км` : ''}
          · ${dir.topCustomers.map(([name, count]) =>
    `<span data-cust-card="${escapeHtml(name)}" title="CRM-карточка клиента" style="text-decoration:underline;cursor:pointer">${escapeHtml(name.slice(0, 24))}</span> (${count})`).join(', ')}</small></span>
      <button class="button small" data-fill-form="${escapeHtml(dir.from)}|${escapeHtml(dir.to)}|${dir.median}"
        title="Заполнить форму бронирования направлением и рыночной ставкой">→ в форму</button>
    </div>`).join('') || '<div class="muted" style="padding:4px 0">Регулярных направлений из зоны нет — спот-запрос в чат.</div>';
    return `<div class="list-item" style="display:block">
      <div style="display:flex;gap:8px;align-items:baseline;flex-wrap:wrap">
        <strong>${escapeHtml(group.zone)}</strong>
        <span class="badge ${group.idleDayPlus ? 'bad' : 'ok'}"
          title="Без брони — доступно продажам; всего свободно вместе с забронированными">без брони ${group.freeNoHold} из ${group.list.length}${group.idleDayPlus ? ` · сутки+ ${group.idleDayPlus}` : ''}</span>
        ${group.lossPerDay ? `<b class="danger" title="Только по незабронированным, стоящим сутки и больше">−${money(group.lossPerDay)}/день простоя</b>` : ''}
      </div>
      <div style="margin:4px 0">${vehiclesHtml}</div>
      ${dirsHtml}
    </div>`;
  };

  const renderChips = () => {
    const box = document.getElementById('radarChips');
    if (!box) return;
    const chips = zonesAll.map(group => {
      const on = filter.zone === group.zone;
      return `<button type="button" class="button ${on ? '' : 'ghost'} small" data-zone-chip="${escapeHtml(group.zone)}"
        title="Свободно без брони / всего">${escapeHtml(group.zone)} <b>${group.freeNoHold}</b>${group.freeNoHold !== group.list.length ? `<small>/${group.list.length}</small>` : ''}</button>`;
    }).join('');
    box.innerHTML = `<button type="button" class="button ${filter.zone ? 'ghost' : ''} small" data-zone-chip="">Все зоны</button>${chips}`;
    box.querySelectorAll('[data-zone-chip]').forEach(chip =>
      chip.addEventListener('click', () => {
        filter.zone = chip.dataset.zoneChip === filter.zone ? '' : chip.dataset.zoneChip;
        renderChips(); renderZones(); renderHoles(); renderMarket();
      }));
  };

  const renderZones = () => {
    const box = document.getElementById('radarZones');
    if (!box) return;
    const groups = zonesAll.filter(group => !filter.zone || group.zone === filter.zone);
    box.innerHTML = groups.map(zoneBlockHtml).join('')
      || '<p class="muted">Свободных машин нет — парк загружен.</p>';
    wireZoneHandlers(box);
  };

  const renderMarket = () => {
    const box = document.getElementById('radarMarket');
    if (!box) return;
    const rows = market.filter(dir => !filter.zone || dir.from === filter.zone || dir.to === filter.zone);
    document.getElementById('radarMarketBadge').textContent = rows.length;
    box.innerHTML = `<table>
      <tr><th>Направление</th><th>Рейсов/нед</th><th>Рынок (медиана)</th><th>Коридор</th><th>₽/км</th><th>Постоянные клиенты</th></tr>
      ${rows.map(dir => `<tr>
        <td><b>${escapeHtml(dir.key)}</b></td>
        <td style="text-align:right">${dir.perWeek.toFixed(1)}</td>
        <td style="text-align:right"><b>${money(dir.median)}</b></td>
        <td style="text-align:right" class="muted">${money(dir.p25)}–${money(dir.p75)}</td>
        <td style="text-align:right">${dir.rubKm ?? '—'}</td>
        <td>${dir.topCustomers.map(([name, count]) => `${escapeHtml(name.slice(0, 26))} (${count})`).join(', ')}</td>
      </tr>`).join('') || '<tr><td colspan="6" class="muted">Пусто.</td></tr>'}
    </table>`;
  };

  const renderHoles = () => {
    const box = document.getElementById('radarHoles');
    const badge = document.getElementById('radarHolesBadge');
    if (!box) return;
    if (!holesAll) { box.innerHTML = '<p class="muted">Загружаю…</p>'; return; }
    const untilIso = new Date(nowMs + (presetDays[filter.preset] || 3) * 86_400_000 + 3 * H).toISOString().slice(0, 10);
    const holes = holesAll.filter(({ dayIso, slot }) => dayIso <= untilIso &&
      (!filter.zone || slot.from_name === filter.zone || slot.to_name === filter.zone));
    if (badge) badge.textContent = holes.length;
    box.innerHTML = holes.slice(0, 50).map(({ dayIso, slot }) => `<div class="dmr-row">
      <span style="flex:1;min-width:0"><b>${dayIso.split('-').reverse().slice(0, 2).join('.')}</b>
        · ${escapeHtml(slot.customer_name)} · ${escapeHtml(slot.from_name)}→${escapeHtml(slot.to_name)}
        <small class="muted" style="display:block">слот ${Math.round(slot.per_day * 10) / 10}/день · ставка ${money(slot.rate)} — заявки нет, позвоните клиенту</small></span>
      <span data-cust-card="${escapeHtml(slot.customer_name)}"
        style="text-decoration:underline;cursor:pointer" title="CRM-карточка">📇</span>
    </div>`).join('') || '<p class="muted">Дыр нет — слоты периода закрыты заявками.</p>';
    wireCustomerLinks(box);
  };

  function wireCustomerLinks(root) {
    root.querySelectorAll('[data-cust-card]').forEach(link =>
      link.addEventListener('click', () => {
        import('./customer-card.js').then(module =>
          module.customerCardDialog(link.dataset.custCard, context));
      }));
  }

  function wireZoneHandlers(root) {
    wireCustomerLinks(root);
    // Бронь: после ответа API обновляем локальные структуры и перерисовываем
    // только секцию зон — без onReload и полного перезапуска экрана.
    root.querySelectorAll('[data-hold-vehicle]').forEach(badge =>
      badge.addEventListener('click', async () => {
        const vehicleId = badge.dataset.holdVehicle;
        const entry = zonesAll.flatMap(group => group.list).find(item => item.vehicle.id === vehicleId);
        try {
          if (entry?.hold) {
            await api('/api/vehicle-holds', { method: 'POST', body: JSON.stringify({ vehicleId, remove: true }) });
            entry.hold = null;
            data.vehicleHolds = (data.vehicleHolds || []).filter(hold => hold.vehicle_id !== vehicleId);
            toast('Бронь снята');
          } else {
            const note = prompt('Бронь на 24 часа. Пометка (клиент/сделка):', '') ?? null;
            if (note === null) return;
            const result = await api('/api/vehicle-holds', { method: 'POST', body: JSON.stringify({ vehicleId, note, hours: 24 }) });
            const hold = { vehicle_id: vehicleId, until: result.until, note,
              held_by_name: data.user?.full_name || 'вы' };
            if (entry) entry.hold = hold;
            data.vehicleHolds = [...(data.vehicleHolds || []).filter(item => item.vehicle_id !== vehicleId), hold];
            toast('Забронирована на 24 ч — видно логисту и в подборе ТС');
          }
          // Пересчитать счётчики зон по обновлённым броням.
          for (const group of zonesAll) {
            const noHold = group.list.filter(item => !item.hold);
            group.freeNoHold = noHold.length;
            group.idleDayPlus = noHold.filter(item => item.idleH >= 24).length;
            group.lossPerDay = group.idleDayPlus * DAY_RATE;
          }
          renderChips(); renderZones();
        } catch (error) { toast(error.message, 'error'); }
      }));
    // «→ в форму»: закрыть радар, заполнить зоны и ставку в форме бронирования.
    root.querySelectorAll('[data-fill-form]').forEach(button =>
      button.addEventListener('click', () => {
        const [fromName, toName, rate] = button.dataset.fillForm.split('|');
        const zoneId = name => data.reference.zones.find(zone => zone.name === name)?.id;
        context.closeModal();
        const fromSelect = document.querySelector('#salesFrom');
        if (!fromSelect) { toast('Откройте вкладку «Продажи» — форма бронирования там'); return; }
        if (zoneId(fromName)) fromSelect.value = zoneId(fromName);
        const toSelect = document.querySelector('#salesTo');
        if (zoneId(toName)) toSelect.value = zoneId(toName);
        const rateInput = document.querySelector('#salesRate');
        if (rateInput && !rateInput.value) rateInput.placeholder = Number(rate).toLocaleString('ru-RU');
        fromSelect.dispatchEvent(new Event('change', { bubbles: true }));
        document.querySelector('#salesForm')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
        toast(`Форма заполнена: ${fromName} → ${toName}, рынок ${money(Number(rate))}`);
      }));
  }

  document.querySelectorAll('[data-preset]').forEach(button =>
    button.addEventListener('click', () => {
      filter.preset = button.dataset.preset;
      document.querySelectorAll('[data-preset]').forEach(other =>
        other.classList.toggle('ghost', other.dataset.preset !== filter.preset));
      renderHoles();
    }));
  document.querySelector(`[data-preset="${filter.preset}"]`)?.classList.remove('ghost');

  renderChips(); renderZones(); renderMarket(); renderHoles();

  // Дыры: план вывоза текущего и следующего месяца грузится один раз.
  (async () => {
    const list = [];
    try {
      const months = [new Date(nowMs + 3 * H).toISOString().slice(0, 7),
        new Date(nowMs + 30 * 86_400_000).toISOString().slice(0, 7)];
      for (const month of [...new Set(months)]) {
        const plan = await api(`/api/delivery-plan?month=${month}`);
        for (let day = 1; day <= plan.daysInMonth; day += 1) {
          const dayIso = `${month}-${String(day).padStart(2, '0')}`;
          if (dayIso < new Date(nowMs + 3 * H).toISOString().slice(0, 10)) continue;
          const weekday = (plan.firstWeekday + day - 1) % 7;
          for (const slot of plan.slots) {
            if (slot.weekday !== weekday || slot.per_day < 0.5) continue;
            if (plan.facts[`${slot.customer_name}|${slot.from_zone_id}|${slot.to_zone_id}|${day}`]) continue;
            list.push({ dayIso, slot });
          }
        }
      }
    } catch { /* план недоступен — секция останется пустой */ }
    holesAll = list.sort((a, b) => a.dayIso.localeCompare(b.dayIso));
    renderHoles();
  })();
}
