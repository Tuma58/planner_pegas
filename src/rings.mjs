// Постоянные кольца парка и панель «Загрузка кругов» (решение
// руководителя 15.09.2026). Шаблоны кругов — единственный источник —
// живут в public/assets/rounds.js и импортируются сюда же: фронт и
// сервер считают одинаково. Здесь: живой зазор стыковки (норматив),
// факт недели по плечам шаблонов и сводка «план машин ↔ факт ↔ дыра».
import { ROUND_TEMPLATES, roundKm, roundVehicles } from '../public/assets/rounds.js';

// Кламп живого зазора стыковки и фолбэк — факт августа 0,85 дня на
// плечо (см. rounds.js). Зазор меньше 0,2 дня физически не живёт
// (оформление+подгон), больше 1,5 — это уже простой, не стыковка.
export const DOCK_GAP_FALLBACK = 0.85;
export const DOCK_GAP_CLAMP = [0.2, 1.5];
const DAY_MS = 86_400_000;

// Живой зазор стыковки: медиана паузы «конец рейса → начало следующего»
// одной машины. Паузы длиннее 5 суток — простой/ремонт, не стыковка:
// в образцы не берутся. Меньше 8 образцов или медиана вне клампа —
// работает фолбэк, и это видно по learned=false.
export function dockGapDays(pauses) {
  const clean = pauses.filter(days => days >= 0 && days <= 5).sort((a, b) => a - b);
  if (clean.length < 8) return { days: DOCK_GAP_FALLBACK, samples: clean.length, learned: false };
  const median = clean[Math.floor(clean.length / 2)];
  if (median < DOCK_GAP_CLAMP[0] || median > DOCK_GAP_CLAMP[1]) {
    return { days: DOCK_GAP_FALLBACK, samples: clean.length, learned: false };
  }
  return { days: Math.round(median * 100) / 100, samples: clean.length, learned: true };
}

export function collectDockPauses(db) {
  const rows = db.prepare(`SELECT vehicle_id, starts_at,
      COALESCE(unloaded_at, ends_at) done_at
    FROM trips WHERE status IN ('run','unloaded','done','paid')
      AND starts_at >= datetime('now','-30 day')
    ORDER BY vehicle_id, starts_at`).all();
  const pauses = [];
  for (let index = 1; index < rows.length; index += 1) {
    if (rows[index].vehicle_id !== rows[index - 1].vehicle_id) continue;
    const gap = (Date.parse(rows[index].starts_at) - Date.parse(rows[index - 1].done_at)) / DAY_MS;
    if (Number.isFinite(gap)) pauses.push(gap);
  }
  return pauses;
}

// Метка плеча шаблона — направление; реальные рейсы едут в конкретные
// зоны системы. Куст зон направления — географическая таксономия (как
// REGION_PATTERNS в сервере), не бизнес-порог.
export const LEG_ZONE_GROUPS = {
  'Восток': ['Восток', 'Новосибирск', 'Омск', 'Томск', 'Кузбасс', 'Красноярск', 'Алтай']
};
export const legZoneNames = label => LEG_ZONE_GROUPS[label] || [label];

// Факт по кругам — ПОСЛЕДОВАТЕЛЬНЫЙ матчинг: цикл круга = машина
// прошла гружёные плечи шаблона по порядку (между плечами допускается
// один рейс-заполнитель — локалки для того и существуют). Считать по
// отдельным плечам нельзя: Дом→Москва есть в К1/К2/К2п/К4б, и min по
// плечам приписывает чужие рейсы каждому кругу. Каждый рейс участвует
// максимум в одном цикле; длинные шаблоны матчатся первыми, чтобы
// К2 (с возвратом из Самары) не распался на К2п + хвост.
export function matchRingCycles(rounds, trips, zoneIdsByName) {
  const idsOf = label => new Set(legZoneNames(label)
    .map(name => zoneIdsByName.get(name)).filter(Boolean));
  const byVehicle = new Map();
  for (const trip of trips) {
    if (!byVehicle.has(trip.vehicle_id)) byVehicle.set(trip.vehicle_id, []);
    byVehicle.get(trip.vehicle_id).push(trip);
  }
  for (const list of byVehicle.values()) {
    list.sort((a, b) => String(a.starts_at).localeCompare(String(b.starts_at)));
  }
  const loadedLegs = round => round.legs.filter(leg => leg.kind !== 'П');
  const stats = new Map(rounds.map(round => [round.key, { cycles: 0, vehicles: new Set() }]));
  const used = new Set();
  const ordered = [...rounds].sort((a, b) => loadedLegs(b).length - loadedLegs(a).length);
  for (const round of ordered) {
    const legs = loadedLegs(round).map(leg => ({ from: idsOf(leg.from), to: idsOf(leg.to) }));
    if (!legs.length) continue;
    const stat = stats.get(round.key);
    for (const [vehicleId, list] of byVehicle) {
      let legIndex = 0;
      let skips = 0;
      let picked = [];
      const reset = trip => {
        picked = []; legIndex = 0; skips = 0;
        // Сорвавший цепочку рейс может сам начинать новый цикл.
        if (trip && legs[0].from.has(trip.from_zone_id) && legs[0].to.has(trip.to_zone_id)) {
          picked.push(trip); legIndex = 1;
        }
      };
      for (const trip of list) {
        if (used.has(trip.id)) continue;
        const leg = legs[legIndex];
        if (leg.from.has(trip.from_zone_id) && leg.to.has(trip.to_zone_id)) {
          picked.push(trip); legIndex += 1; skips = 0;
          if (legIndex === legs.length) {
            for (const item of picked) used.add(item.id);
            stat.cycles += 1;
            stat.vehicles.add(vehicleId);
            picked = []; legIndex = 0;
          }
        } else if (legIndex > 0 && (skips += 1) > 1) reset(trip);
      }
    }
  }
  return stats;
}

// Данные панели «⭕ Загрузка кругов»: по каждому шаблону — план машин
// при живом зазоре, закреплённые борта (vehicle_round_plans), кольцо в
// Конструкторе (routes.ring_key), факт циклов за окно и дыра. План и
// факт в одной единице — машины непрерывной занятости: цикл стоит
// (км/538 + гружёные плечи × зазор) машино-дней, план = месячный объём
// шаблона × цена цикла, факт = сделанные циклы × та же цена. Дыра —
// недобор ОБЪЁМА в машинах; её цена — маржа шаблона за месяц.
export const RING_WINDOW_DAYS = 28;

export function ringLoadData(db) {
  const gap = dockGapDays(collectDockPauses(db));
  const zoneIdsByName = new Map(db.prepare('SELECT id,name FROM zones').all()
    .map(zone => [zone.name, zone.id]));
  const plans = db.prepare(`SELECT p.round_key, v.plate FROM vehicle_round_plans p
    JOIN vehicles v ON v.id=p.vehicle_id ORDER BY v.plate`).all();
  const rings = db.prepare(`SELECT id, route_no, status, close_reason, ring_key
    FROM routes WHERE ring_key IS NOT NULL`).all();
  // Окно 28 дней: в неделю полный цикл К5 (две недели) не помещается.
  const windowTrips = db.prepare(`SELECT id, vehicle_id, from_zone_id, to_zone_id, starts_at
    FROM trips WHERE status IN ('run','unloaded','done','paid')
      AND starts_at >= datetime('now','-${RING_WINDOW_DAYS} day')`).all();
  const stats = matchRingCycles(ROUND_TEMPLATES, windowTrips, zoneIdsByName);
  const items = ROUND_TEMPLATES.map(round => {
    const stat = stats.get(round.key);
    const loaded = round.legs.filter(leg => leg.kind !== 'П').length;
    // Машино-дни одного цикла — та же формула, что в roundVehicles.
    const cycleVehicleDays = roundKm(round) / 538 + loaded * gap.days;
    const planVehicles = Math.round(roundVehicles(round, gap.days) * 10) / 10;
    const factVehicles = Math.round(stat.cycles * cycleVehicleDays / RING_WINDOW_DAYS * 10) / 10;
    const assigned = plans.filter(plan => plan.round_key === round.key)
      .map(plan => plan.plate);
    const holeVehicles = Math.max(0, Math.round((planVehicles - factVehicles) * 10) / 10);
    return {
      key: round.key, name: round.name, days: round.days,
      marginDay: round.marginDay, volume: round.volume, note: round.note,
      planVehicles, assigned, holeVehicles,
      week: {
        cycles: stat.cycles,
        cyclesWeek: Math.round(stat.cycles / (RING_WINDOW_DAYS / 7) * 10) / 10,
        vehicles: stat.vehicles.size, factVehicles
      },
      holeMarginMonth: Math.round(holeVehicles * round.marginDay * 30),
      ring: rings.find(ring => ring.ring_key === round.key) || null
    };
  });
  return { gap, windowDays: RING_WINDOW_DAYS, items };
}
