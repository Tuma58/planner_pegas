// Отчёт «Машино-ёмкость клиентов»: сколько машин парка фактически занимает
// каждый клиент и как у него складывается круг (заказ руководителя 28.10).
//
// Машино-ёмкость = машино-часы рейсов клиента + стык ПОСЛЕ его выгрузки —
// хвост до следующей погрузки вменяется клиенту, потому что его оставляет
// география клиента (есть обратный груз — хвоста нет). «Круг» — доля
// случаев, когда следующий груз взят в зоне выгрузки клиента. Деньги —
// только канон (tripNet), ничего своей формулой.
import { DONE_STATUSES, calcSettings, tripNet } from './money.mjs';

const HOUR = 3_600_000;
const median = list => {
  if (!list.length) return null;
  const sorted = [...list].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

export function clientFleetData(db, from, to) {
  const calc = calcSettings(db);
  const zones = new Map(db.prepare(`SELECT id, name FROM zones`).all()
    .map(zone => [zone.id, zone.name]));
  // Километры — лестницей честности (28.10): одометр Пилота за интервал
  // рейса (gps_km, покрытие ~70%, на дальних 87%) → телематика 1С → план.
  // Прежний COALESCE начинался с мёртвого поля 1С и всегда давал план —
  // ₽/км дальних клиентов занижался планом, завышенным на ~12%.
  const rows = db.prepare(`SELECT vehicle_id, status, cash, customer_name, revenue_vat,
      starts_at, unloaded_at, ends_at, from_zone_id, to_zone_id,
      COALESCE(gps_km, actual_distance_km, distance_km) km FROM trips
    WHERE status<>'rejected' ORDER BY vehicle_id, starts_at`).all();
  const days = Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 864e5));

  const byClient = new Map();
  const misses = new Map();
  for (let i = 0; i < rows.length; i++) {
    const trip = rows[i];
    if (!DONE_STATUSES.has(trip.status)) continue;
    const endIso = trip.unloaded_at || trip.ends_at;
    const day = String(endIso).slice(0, 10);
    if (day < from || day >= to) continue;
    const durH = (Date.parse(endIso) - Date.parse(trip.starts_at)) / HOUR;
    // Рваные отметки (нулевые и месячные «рейсы») портят часы — мимо.
    if (!(durH > 1 && durH < 21 * 24)) continue;
    const next = rows[i + 1]?.vehicle_id === trip.vehicle_id ? rows[i + 1] : null;
    const item = byClient.get(trip.customer_name)
      || { name: trip.customer_name, trips: 0, rev: 0, tripH: 0, km: 0, gaps: [],
        ring: 0, broken: 0, closers: new Map() };
    item.trips += 1;
    item.rev += tripNet(trip, calc);
    item.tripH += durH;
    item.km += Number(trip.km || 0);
    if (next) {
      const gapH = (Date.parse(next.starts_at) - Date.parse(endIso)) / HOUR;
      if (gapH >= 0 && gapH <= 7 * 24) {
        item.gaps.push(gapH);
        if (next.from_zone_id === trip.to_zone_id) {
          item.ring += 1;
          // Кто замыкает круг: чей груз машина берёт в зоне выгрузки.
          item.closers.set(next.customer_name,
            (item.closers.get(next.customer_name) || 0) + 1);
        } else {
          item.broken += 1;
          const key = `${zones.get(trip.to_zone_id) || '?'} ⇢ ${zones.get(next.from_zone_id) || '?'}`;
          misses.set(key, (misses.get(key) || 0) + 1);
        }
      }
    }
    byClient.set(trip.customer_name, item);
  }

  const clients = [...byClient.values()].map(item => {
    const gapH = item.gaps.reduce((sum, gap) => sum + gap, 0);
    const totalH = item.tripH + gapH;
    const chains = item.ring + item.broken;
    // Замыкающие круг: топ-3 клиентов, чьи грузы подхватываются в зоне
    // выгрузки (доля от всех цепочек — и замкнутых, и разорванных).
    const closers = [...item.closers].sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([name, count]) => ({ name,
        pct: Math.round(count / chains * 100) }));
    return {
      name: item.name, trips: item.trips,
      revNet: Math.round(item.rev),
      revPerDay: Math.round(item.rev / days),
      avgCheck: Math.round(item.rev / item.trips),
      rubKm: item.km >= 100 ? Math.round(item.rev / item.km) : null,
      km: Math.round(item.km),
      busyDays: Math.round(totalH / 24),
      vehicles: Math.round(totalH / 24 / days * 10) / 10,
      vehiclesGap: Math.round(gapH / 24 / days * 10) / 10,
      revPerVd: totalH ? Math.round(item.rev / (totalH / 24)) : 0,
      gapMedianH: item.gaps.length ? Math.round(median(item.gaps)) : null,
      ringPct: chains ? Math.round(item.ring / chains * 100) : null,
      closers
    };
  }).sort((a, b) => b.vehicles - a.vehicles);

  const fleet = db.prepare(`SELECT COUNT(*) c FROM vehicles WHERE status='work'`).get().c;
  return {
    from, to, days, fleet,
    clients,
    totalVehicles: Math.round(clients.reduce((sum, c) => sum + c.vehicles, 0) * 10) / 10,
    totalGapVehicles: Math.round(clients.reduce((sum, c) => sum + c.vehiclesGap, 0) * 10) / 10,
    brokenRings: [...misses].map(([route, count]) => ({ route, count }))
      .sort((a, b) => b.count - a.count).slice(0, 15)
  };
}
