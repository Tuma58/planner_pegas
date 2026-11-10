// ── Платные парковки (Москва, АМПП) ────────────────────────────────────
// Справочник платных точек УЧИТСЯ из парковочных штрафов (ст. 8.14 КоАП
// Москвы): место постановления несёт улицу и дом. Секции одной парковки
// (№4092 (1)/(3)/(5)…) и написания с «ГОРОД МОСКВА,» сливаются ключом
// «улица|дом». Контур двойного контроля: предупреждение в форме заявки
// (адрес погрузки/выгрузки в радиусе точки), уведомление диспетчеру при
// старте рейса на такую точку и GPS-контроль фактической стоянки —
// парковочную сессию запускают в ЛК юрлица Моспаркинга (API у города
// нет), планер отвечает за то, чтобы о ней ВСПОМНИЛИ.

// Разбор места парковочного постановления. Живые форматы:
// «ПАРКОВКА №4092 (5) ГОРОД МОСКВА, ПЕРМСКАЯ УЛИЦА, ДОМ 3, СТРОЕНИЕ 26,
// МОСКВА Г.», «ПЕРМСКАЯ УЛИЦА, ДОМ 1, СТРОЕНИЕ 5, МОСКВА Г.»,
// «УСАЧЕВА, д.29, к.1, ХАМОВНИКИ (ЦАО) Р-Н, МОСКВА Г.»,
// «ЛЕНИНГРАДСКОЕ Ш., д.63, к.1, …».
export function parseParkingLocation(location) {
  let text = String(location || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const noMatch = text.match(/ПАРКОВКА\s*№\s*(\d+)/iu);
  const parkingNo = noMatch ? noMatch[1] : '';
  text = text.replace(/ПАРКОВКА\s*№\s*\d+\s*(\(\d+\))?\s*/iu, '')
    .replace(/^город\s+москва\s*,?\s*/iu, '').replace(/^москва\s*,?\s*/iu, '');
  const parts = text.split(',').map(part => part.trim()).filter(Boolean);
  if (!parts.length) return null;
  const street = parts[0].replace(/\s+,/g, ',').trim();
  if (street.length < 3 || /^дом\b|^д\./iu.test(street)) return null;
  const houseMatch = text.match(/(?:дом|д)\.?\s*(\d+[а-яё]?\d*)/iu);
  if (!houseMatch) return null;
  return { parkingNo, street, house: houseMatch[1].toUpperCase(), city: 'Москва' };
}

// Ключ слияния секций и написаний: улица без типа/регистра + дом.
export function parkingKey(parsed) {
  if (!parsed) return '';
  // Тип улицы вырезается lookaround-границами: \b не знает кириллицы.
  const street = parsed.street.toLowerCase().replace(/ё/g, 'е')
    .replace(/(?<![а-я])(улица|ул|проспект|просп|пр-т|шоссе|ш|бульвар|б-р|переулок|пер|набережная|наб|проезд)(?![а-я])\.?/g, '')
    .replace(/[^а-яa-z0-9]+/g, '');
  return `${street}|${parsed.house.toLowerCase()}`;
}

export function migrateParkingZones(db) {
  // Радиус платной точки (м): адрес заявки или стоянка борта ближе —
  // срабатывает контроль. Настройка руководителя, дефолт вместо пустоты.
  const calcRow = db.prepare(`SELECT value_json FROM settings WHERE key='calculation'`).get();
  if (calcRow) {
    const calculation = JSON.parse(calcRow.value_json);
    if (calculation.paidParkRadiusM == null) {
      calculation.paidParkRadiusM = 400;
      db.prepare(`UPDATE settings SET value_json=? WHERE key='calculation'`)
        .run(JSON.stringify(calculation));
    }
  }
  db.exec(`CREATE TABLE IF NOT EXISTS paid_park_zones (
    id TEXT PRIMARY KEY,
    zone_key TEXT NOT NULL UNIQUE,
    parking_no TEXT NOT NULL DEFAULT '',
    street TEXT NOT NULL,
    house TEXT NOT NULL,
    city TEXT NOT NULL DEFAULT 'Москва',
    location TEXT NOT NULL DEFAULT '',
    latitude REAL, longitude REAL,
    geo_status TEXT NOT NULL DEFAULT '',
    geo_try_at TEXT,
    fines_count INTEGER NOT NULL DEFAULT 0,
    fines_amount REAL NOT NULL DEFAULT 0,
    last_offense_on TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
}

// Пересборка справочника из штрафов: новые точки добавляются, счётчики
// обновляются; координаты и enabled не трогаются.
export function rebuildParkingZones(db, randomUUID) {
  const rows = db.prepare(`SELECT location, COUNT(*) c, SUM(amount) s, MAX(offense_on) mx
    FROM gibdd_fines
    WHERE (article_number LIKE '%8.14%' OR location LIKE '%ПАРКОВКА №%') AND location<>''
    GROUP BY location`).all();
  const byKey = new Map();
  for (const row of rows) {
    const parsed = parseParkingLocation(row.location);
    if (!parsed) continue;
    const key = parkingKey(parsed);
    const item = byKey.get(key) || { ...parsed, location: row.location, count: 0, amount: 0, last: '' };
    item.count += row.c;
    item.amount += row.s;
    if (row.mx > item.last) item.last = row.mx;
    if (parsed.parkingNo && !item.parkingNo) item.parkingNo = parsed.parkingNo;
    byKey.set(key, item);
  }
  const insert = db.prepare(`INSERT INTO paid_park_zones(id, zone_key, parking_no, street, house,
      city, location, fines_count, fines_amount, last_offense_on)
    VALUES(?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(zone_key) DO UPDATE SET fines_count=excluded.fines_count,
      fines_amount=excluded.fines_amount, last_offense_on=excluded.last_offense_on,
      parking_no=CASE WHEN paid_park_zones.parking_no='' THEN excluded.parking_no ELSE paid_park_zones.parking_no END,
      updated_at=CURRENT_TIMESTAMP
    WHERE paid_park_zones.fines_count<>excluded.fines_count
      OR paid_park_zones.fines_amount<>excluded.fines_amount`);
  const before = db.prepare(`SELECT COUNT(*) c FROM paid_park_zones`).get().c;
  for (const [key, item] of byKey) {
    insert.run(randomUUID(), key, item.parkingNo, item.street, item.house, item.city,
      item.location, item.count, item.amount, item.last);
  }
  return { zones: byKey.size, added: db.prepare(`SELECT COUNT(*) c FROM paid_park_zones`).get().c - before };
}

// Расстояние точка–точка в метрах (хаверсин без дорожного коэффициента).
export function distanceM(a, b) {
  const nums = [a?.latitude, a?.longitude, b?.latitude, b?.longitude];
  if (!nums.every(Number.isFinite)) return null;
  const rad = value => value * Math.PI / 180;
  const h = Math.sin(rad(b.latitude - a.latitude) / 2) ** 2 +
    Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(rad(b.longitude - a.longitude) / 2) ** 2;
  return Math.round(2 * 6_371_000 * Math.asin(Math.sqrt(h)));
}

// Платная точка в радиусе от координаты (адреса заявки или позиции борта).
export function parkZoneNear(db, point, radiusM) {
  if (!radiusM || !point) return null;
  let best = null;
  for (const zone of db.prepare(`SELECT * FROM paid_park_zones
      WHERE enabled=1 AND latitude IS NOT NULL AND longitude IS NOT NULL`).all()) {
    const away = distanceM(point, zone);
    if (away == null || away > radiusM) continue;
    if (!best || away < best.awayM) best = { ...zone, awayM: away };
  }
  return best;
}

export function parkZoneLabel(zone) {
  return `${zone.parking_no ? `№${zone.parking_no} · ` : ''}${zone.street}, ${zone.house}`;
}
