// Ревизия назначенных рейсов: зазоры между заданиями сцепки в плане.
// Запуск: node tools/revizia-gaps.mjs <путь к базе> [--send]
// Чистый зазор = старт следующего − конец текущего − время подгона.
// Завышенным считаем > 12 часов (цель стыковки — 8). Запуск с --send
// рассылает персональный отчёт всем действующим сотрудникам.
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[2] || '/app/data/planner.db');
const send = process.argv.includes('--send');
const MSK = ms => new Date(ms + 3 * 3_600_000).toISOString().replace('T', ' ').slice(5, 16);
const rows = db.prepare(`SELECT t.id, t.vehicle_id, t.order_no, t.starts_at, t.ends_at,
    t.unloaded_at, t.status, t.empty_km, v.plate,
    (SELECT name FROM zones WHERE id=t.to_zone_id) to_name,
    (SELECT name FROM zones WHERE id=t.from_zone_id) from_name
  FROM trips t JOIN vehicles v ON v.id=t.vehicle_id
  WHERE t.status IN ('plan','run') ORDER BY t.vehicle_id, t.starts_at`).all();
const byVehicle = new Map();
for (const r of rows) {
  if (!byVehicle.has(r.vehicle_id)) byVehicle.set(r.vehicle_id, []);
  byVehicle.get(r.vehicle_id).push(r);
}
const gaps = [];
for (const list of byVehicle.values()) {
  for (let i = 1; i < list.length; i += 1) {
    const prev = list[i - 1];
    const next = list[i];
    const prevEnd = Date.parse(prev.unloaded_at
      ? String(prev.unloaded_at).replace(' ', 'T') + (String(prev.unloaded_at).includes('Z') ? '' : 'Z')
      : prev.ends_at);
    const feedH = (Number(next.empty_km) || 0) / 50 * 1.5;
    const gapH = (Date.parse(next.starts_at) - prevEnd) / 3_600_000 - feedH;
    // Диспозиция в зазоре (пересменка/ремонт) — простой объяснён.
    const covered = db.prepare(`SELECT COUNT(*) c FROM vehicle_dispositions
      WHERE vehicle_id=? AND datetime(starts_at) < datetime(?) AND datetime(ends_at) > datetime(?)`)
      .get(prev.vehicle_id, next.starts_at, new Date(prevEnd).toISOString()).c;
    if (gapH > 12 && !covered) {
      gaps.push({ plate: prev.plate, gapH: Math.round(gapH),
        prevNo: prev.order_no, prevEnd, prevTo: prev.to_name,
        nextNo: next.order_no, nextStart: Date.parse(next.starts_at), feedH: Math.round(feedH) });
    }
  }
}
gaps.sort((a, b) => b.gapH - a.gapH);
console.log('Пар рейсов с завышенным зазором (>12 ч чистыми, без диспозиции):', gaps.length);
for (const g of gaps) {
  console.log(`${g.plate}: №${g.prevNo} (${g.prevTo}, до ${MSK(g.prevEnd)}) → №${g.nextNo} (выход ${MSK(g.nextStart)})` +
    ` — зазор ${g.gapH} ч${g.feedH ? ` сверх подгона ${g.feedH} ч` : ''}`);
}
const lostRub = gaps.reduce((s, g) => s + g.gapH, 0) * 770;
console.log('Итого часов зазора:', gaps.reduce((s, g) => s + g.gapH, 0), '≈', Math.round(lostRub / 1000), 'т₽ маржи');
if (send && gaps.length) {
  const lines = gaps.slice(0, 12).map(g =>
    `${g.plate}: после №${g.prevNo} (${g.prevTo}) до №${g.nextNo} — простой ~${g.gapH} ч (выгрузка ${MSK(g.prevEnd)} МСК → выход ${MSK(g.nextStart)} МСК)`);
  const text = `📋 Ревизия назначенных рейсов: у ${gaps.length} пар заданий завышен простой между рейсами ` +
    `(больше 12 ч сверх подгона, без ремонта/пересменки в зазоре) — суммарно ${gaps.reduce((s, g) => s + g.gapH, 0)} ч ` +
    `≈ ${Math.round(lostRub / 1000)} т₽ упущенной маржи. ${lines.join('; ')}${gaps.length > 12 ? ` и ещё ${gaps.length - 12}` : ''}. ` +
    `Что делать: сдвинуть следующий рейс раньше, вставить короткое плечо (локалку) или спот — «Логист → Сцепки» и «⏭ стыковка плеча»`;
  const users = db.prepare(`SELECT id FROM users WHERE active=1 AND deleted_at IS NULL`).all();
  const insert = db.prepare(`INSERT INTO messages(author_name,kind,text,recipient_id)
    VALUES('Конвейер','auto',?,?)`);
  for (const u of users) insert.run(text, u.id);
  console.log('Отправлено лично сотрудникам:', users.length);
}
