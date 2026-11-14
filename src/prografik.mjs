// «Производственный график» Э3 — единый балансовый слой (лаборатория
// prografik-lab, конструкция docs/prografik-constr.md). Одна функция
// считает матрицу зоны×дни (спрос без машины / свободно машин / выручка),
// строку баланса и сигнальную полосу — график, ТВ-режим и (при переносе)
// прочие поверхности берут баланс отсюда, а не считают дублями.
// Только чтение существующих таблиц; записи здесь нет и не будет.

const DAY_MS = 86_400_000;
const MSK_MS = 3 * 3_600_000;

// Перцентиль по выборке (для живого порога «освобождается много машин»).
function percentile(values, share) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))];
}

// Живой порог сигнала «освобождается много машин»: p80 таких же волн
// (свободна в день D, накануне была в рейсе) по будущим дням месяца —
// сигналят только НЕОБЫЧНО большие волны своего же горизонта (будущее
// всегда «свободнее» прошлого: следующие рейсы ещё не назначены, и
// абсолютный порог из истории горел бы каждый день). Мало образцов —
// фолбэк-формула 10% парка. Кламп: от 2 машин до половины парка.
function freedThresholdOf(waves, fleetSize) {
  const p80 = waves.length >= 5 ? percentile(waves, 0.8) : null;
  const raw = p80 ?? Math.round(fleetSize * 0.1);
  return { value: Math.min(Math.max(2, Math.round(fleetSize / 2)), Math.max(2, raw)),
    samples: waves.length, raw, learned: p80 !== null };
}

export function prografikData(db, month) {
  const daysInMonth = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
  const days = Array.from({ length: daysInMonth }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
  const monthStartIso = new Date(Date.parse(`${month}-01T00:00:00Z`) - MSK_MS).toISOString();
  const monthEndIso = new Date(Date.parse(`${month}-01T00:00:00Z`) - MSK_MS + daysInMonth * DAY_MS).toISOString();
  const todayIso = new Date(Date.now() + MSK_MS).toISOString().slice(0, 10);

  const slots = db.prepare(`SELECT s.customer_name, s.from_zone_id, s.to_zone_id, s.weekday,
      s.per_day, s.rate, s.transit_hours, f.name from_name, t.name to_name
    FROM delivery_slots s JOIN zones f ON f.id=s.from_zone_id JOIN zones t ON t.id=s.to_zone_id`).all();
  // Живые заявки месяца (окно в месяце); без trip_id — спрос без машины.
  const orders = db.prepare(`SELECT o.id, o.order_no, o.customer_name, o.from_zone_id, o.to_zone_id,
      f.name from_name, t.name to_name, o.window_from, o.window_to, o.rate_vat, o.trip_id,
      o.body_type, o.from_point, o.to_point, o.from_address_id
    FROM orders o JOIN zones f ON f.id=o.from_zone_id JOIN zones t ON t.id=o.to_zone_id
    WHERE o.deleted_at IS NULL AND o.status<>'cancelled' AND o.window_from<? AND o.window_to>=?`)
    .all(monthEndIso, monthStartIso);
  const trips = db.prepare(`SELECT t.id, t.vehicle_id, t.starts_at, t.ends_at, t.unloaded_at,
      t.status, zf.name from_name, zt.name to_name, t.revenue_vat, t.customer_name
    FROM trips t JOIN zones zf ON zf.id=t.from_zone_id JOIN zones zt ON zt.id=t.to_zone_id
    WHERE t.status<>'rejected' AND t.starts_at<? AND t.ends_at>?`).all(monthEndIso, monthStartIso);
  const dispositions = db.prepare(`SELECT vehicle_id, kind, starts_at, ends_at
    FROM vehicle_dispositions WHERE starts_at<? AND ends_at>?`).all(monthEndIso, monthStartIso);
  const vehicles = db.prepare(`SELECT v.id, v.plate, v.driver_name, vt.name type_name,
      z.name zone_name
    FROM vehicles v LEFT JOIN vehicle_types vt ON vt.id=v.type_id
    LEFT JOIN zones z ON z.id=v.zone_id
    WHERE v.status='work' ORDER BY v.plate`).all();
  const rounds = db.prepare(`SELECT vehicle_id, round_key, note FROM vehicle_round_plans`).all();
  // Пункты последней заявки каждого плеча — для «заявки из плана» в ячейке
  // (тот же приём, что в /api/delivery-plan: форма не пустая).
  const lastPoints = {};
  for (const row of db.prepare(`SELECT customer_name, from_zone_id, to_zone_id,
      from_point, to_point, from_address_id, to_address_id, temperature_mode, body_type,
      MAX(created_at) m
    FROM orders WHERE deleted_at IS NULL
    GROUP BY customer_name, from_zone_id, to_zone_id`).all()) {
    lastPoints[`${row.customer_name}|${row.from_zone_id}|${row.to_zone_id}`] = {
      fromPoint: row.from_point, toPoint: row.to_point,
      fromAddressId: row.from_address_id, toAddressId: row.to_address_id,
      temperatureMode: row.temperature_mode, bodyType: row.body_type
    };
  }

  // Рейсы по машинам (отсортированы по окончанию) — для зоны и занятости.
  const byVehicle = new Map();
  for (const trip of trips) {
    if (!byVehicle.has(trip.vehicle_id)) byVehicle.set(trip.vehicle_id, []);
    byVehicle.get(trip.vehicle_id).push(trip);
  }
  const dispoByVehicle = new Map();
  for (const item of dispositions) {
    if (!dispoByVehicle.has(item.vehicle_id)) dispoByVehicle.set(item.vehicle_id, []);
    dispoByVehicle.get(item.vehicle_id).push(item);
  }
  const busyUntil = trip => Date.parse(trip.unloaded_at || trip.ends_at);
  // Зона машины на начало дня — выгрузка последнего завершившегося к этому
  // моменту рейса, фолбэк — приписка (та же логика, что была в Э1 на клиенте).
  const vehicleZoneOn = (vehicleId, dayStartMs, fallback) => {
    let best = null;
    for (const trip of byVehicle.get(vehicleId) || []) {
      const end = busyUntil(trip);
      if (end <= dayStartMs && (!best || end > best.end)) best = { end, zone: trip.to_name };
    }
    return best ? best.zone : fallback;
  };
  const busyOn = (vehicleId, dayStartMs) =>
    (byVehicle.get(vehicleId) || []).some(trip =>
      Date.parse(trip.starts_at) < dayStartMs + DAY_MS && busyUntil(trip) > dayStartMs) ||
    (dispoByVehicle.get(vehicleId) || []).some(item =>
      Date.parse(item.starts_at) < dayStartMs + DAY_MS && Date.parse(item.ends_at) > dayStartMs);

  // Свободные машины по зонам на каждый день (индексы в массиве vehicles —
  // компактнее UUID в разы: диета полезной нагрузки).
  const freeByDay = {};   // iso → { зона → [индексы vehicles] }
  const totalByDay = {};  // iso → { зона → всего машин в зоне }
  for (const iso of days) {
    const dayStart = Date.parse(`${iso}T00:00:00Z`) - MSK_MS;
    const freeMap = {}; const totalMap = {};
    vehicles.forEach((vehicle, index) => {
      const zone = vehicleZoneOn(vehicle.id, dayStart, vehicle.zone_name || '—');
      totalMap[zone] = (totalMap[zone] || 0) + 1;
      if (!busyOn(vehicle.id, dayStart)) (freeMap[zone] ??= []).push(index);
    });
    freeByDay[iso] = freeMap; totalByDay[iso] = totalMap;
  }

  // Состав зон: спрос (слоты/заявки) или машины.
  const zoneSet = new Set();
  slots.forEach(slot => zoneSet.add(slot.from_name));
  orders.forEach(order => !order.trip_id && zoneSet.add(order.from_name));
  for (const map of Object.values(totalByDay)) for (const zone of Object.keys(map)) zoneSet.add(zone);
  zoneSet.delete('');

  const weekdayOf = iso => new Date(`${iso}T12:00:00Z`).getUTCDay();
  const openOrders = orders.filter(order => !order.trip_id);
  // День заявки — МСК-день начала окна (как в facts плана вывоза).
  const mskDay = iso => new Date(Date.parse(iso) + MSK_MS).toISOString().slice(0, 10);
  // Покрытие сетки заявками и спрос без ТС по зонам и дням; факт плеч
  // клиентов — компактной картой (для разворота зоны на клиенте).
  const coverByZoneDay = new Map(); // `зона|день` → {covered, unassigned}
  const legFacts = {};              // `клиент|зона из|зона в|день` → [заявок, с ТС, ₽]
  for (const order of orders) {
    const day = mskDay(order.window_from);
    const zoneKey = `${order.from_name}|${day}`;
    if (!coverByZoneDay.has(zoneKey)) coverByZoneDay.set(zoneKey, { covered: 0, unassigned: 0 });
    const cover = coverByZoneDay.get(zoneKey);
    cover.covered += 1;
    if (!order.trip_id) cover.unassigned += 1;
    const legKey = `${order.customer_name}|${order.from_name}|${order.to_name}|${day}`;
    const fact = legFacts[legKey] || (legFacts[legKey] = [0, 0, 0]);
    fact[0] += 1;
    if (order.trip_id) fact[1] += 1;
    fact[2] += Math.round(Number(order.rate_vat || 0));
  }
  // Ячейка зоны за день: недобор сетки (план − внесённые заявки, как в
  // прототипе руководителя — НЕ против вышедших рейсов, иначе заявка без ТС
  // считалась бы дважды) + заявки без ТС; выручка — выгрузки дня в зону.
  const cellOf = (zone, iso) => {
    const wd = weekdayOf(iso);
    const planned = slots.reduce((sum, slot) =>
      sum + (slot.from_name === zone && slot.weekday === wd ? Number(slot.per_day || 0) : 0), 0);
    const started = trips.reduce((sum, trip) =>
      sum + (trip.from_name === zone && String(trip.starts_at).slice(0, 10) === iso ? 1 : 0), 0);
    const cover = coverByZoneDay.get(`${zone}|${iso}`) || { covered: 0, unassigned: 0 };
    const income = trips.reduce((sum, trip) =>
      sum + (trip.to_name === zone && String(trip.unloaded_at || trip.ends_at).slice(0, 10) === iso
        ? Number(trip.revenue_vat || 0) : 0), 0);
    const free = (freeByDay[iso][zone] || []).length;
    const gap = Math.max(0, planned - cover.covered) + cover.unassigned;
    return [Math.round(gap * 10) / 10, free, Math.round(income),
      Math.round(planned * 10) / 10, started, cover.unassigned];
  };
  // cells[зона] = по дням месяца: [спрос▲, свободно, ₽, план, вышло, без ТС]
  const cells = {};
  for (const zone of zoneSet) cells[zone] = days.map(iso => cellOf(zone, iso));
  const zones = [...zoneSet]
    .map(zone => ({ zone, money: cells[zone].reduce((sum, cell) => sum + cell[2], 0) }))
    .sort((a, b) => b.money - a.money);

  // Баланс парка по дням: суммарный спрос / свободно / деньги.
  const balance = days.map((iso, index) => {
    let gap = 0; let income = 0;
    for (const zone of zoneSet) { gap += cells[zone][index][0]; income += cells[zone][index][2]; }
    const free = Object.values(freeByDay[iso]).reduce((sum, list) => sum + list.length, 0);
    return [Math.round(gap * 10) / 10, free, income];
  });

  // ── Сигнальная полоса ──
  // Волна освобождений дня: свободна в D, накануне была в рейсе.
  const freedOf = index => {
    const prevStart = Date.parse(`${days[index - 1]}T00:00:00Z`) - MSK_MS;
    return Object.values(freeByDay[days[index]]).flat()
      .map(vehicleIndex => vehicles[vehicleIndex])
      .filter(vehicle => (byVehicle.get(vehicle.id) || []).some(trip =>
        Date.parse(trip.starts_at) < prevStart + DAY_MS && busyUntil(trip) > prevStart));
  };
  const futureWaves = [];
  for (let index = 1; index < days.length; index += 1) {
    if (days[index] >= todayIso) futureWaves.push(freedOf(index).length);
  }
  const norms = { freed: freedThresholdOf(futureWaves, vehicles.length) };
  const signals = [];
  for (const [index, iso] of days.entries()) {
    if (iso < todayIso) continue;
    const [gap, free] = balance[index];
    if (gap - free > 0) {
      signals.push({ kind: 'deficit', day: iso,
        title: `Дефицит ${Math.ceil(gap - free)} маш · ${iso.slice(8, 10)}.${iso.slice(5, 7)}`,
        sub: `спрос ${gap} · свободно ${free}` });
    }
  }
  // Незакрытая сетка по клиентам (будущие дни): план слота минус вышедшие
  // рейсы минус уже внесённые заявки дня — то, под что нет даже заявки.
  const gridGapByCustomer = new Map();
  for (const [index, iso] of days.entries()) {
    if (iso < todayIso) continue;
    const wd = weekdayOf(iso);
    for (const slot of slots) {
      if (slot.weekday !== wd) continue;
      const planned = Math.round(slot.per_day);
      if (planned <= 0) continue;
      const have = (legFacts[`${slot.customer_name}|${slot.from_name}|${slot.to_name}|${iso}`] || [0])[0];
      if (have < planned) {
        gridGapByCustomer.set(slot.customer_name,
          (gridGapByCustomer.get(slot.customer_name) || 0) + planned - have);
      }
    }
    if (index > 13 && iso > todayIso) break; // горизонт сетки — две недели вперёд
  }
  for (const [customer, miss] of [...gridGapByCustomer.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2)) {
    signals.push({ kind: 'grid', customer,
      title: `Сетка не закрыта: ${customer}`,
      sub: `${miss} слотов без заявок — подтвердить или снять` });
  }
  // Освобождающиеся машины: свободные в D, накануне занятые рейсом —
  // две самые большие волны горизонта не ниже выученного уровня.
  const freeingDays = [];
  for (let index = 1; index < days.length; index += 1) {
    const iso = days[index];
    if (iso < todayIso) continue;
    const freed = freedOf(index);
    if (freed.length >= norms.freed.value) freeingDays.push({ iso, freed });
  }
  for (const { iso, freed } of freeingDays
    .sort((a, b) => b.freed.length - a.freed.length).slice(0, 2)
    .sort((a, b) => a.iso.localeCompare(b.iso))) {
    signals.push({ kind: 'freeing', day: iso,
      title: `Освобождается ${freed.length} маш · ${iso.slice(8, 10)}.${iso.slice(5, 7)}`,
      sub: `${freed.slice(0, 5).map(vehicle => vehicle.plate).join(', ')}${freed.length > 5 ? '…' : ''} — ресурс под новые заявки` });
  }

  return { month, daysInMonth, days, todayIso, zones, cells, balance,
    freeByDay, totalByDay, signals: signals.slice(0, 8), norms, legFacts,
    slots, orders: openOrders, trips, dispositions, vehicles, rounds, lastPoints };
}
