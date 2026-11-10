// ── Рамки весогабаритного контроля (АПВГК) ─────────────────────────────
// Справочник рамок СТРОИТСЯ ИЗ ФАКТА (концепция живых нормативов):
// каждое весогабаритное постановление (ст. 12.21.1) несёт место рамки —
// «NN км NNN м а/д Дорога, Область». Разные написания одного места
// сводятся ключом «дорога|км». Координаты рамки выучиваются геокодом
// концов дороги (точка на прямой между ними в доле километража) — для
// карты и коридора предупреждений этой точности достаточно (±единицы км).
// Руками рамки не вводятся: новая рамка появляется с первым штрафом,
// исправление координат — через обычный геокод-механизм при повторе.

// Разбор места постановления. Поддерживаемые написания (все — живые
// примеры из ЛК): «18 км 790 м а/д Лапотково - Ефремов, Тульская область»,
// «А/Д ЛАПОТКОВО-ЕФРЕМОВ, КМ 18+790, ТУЛЬСКАЯ ОБЛ.», «АВТОМОБИЛЬНАЯ
// ДОРОГА 'ОБХОД Г. ВОРОНЕЖА' 4 КМ + 730 М, …», «379 км+200 м А/Д 1Р-228
// «Сызрань-Саратов-Волгоград», «… а/д 04 ОП РЗ 04K-044 Красноярск -
// Енисейск, Красноярский край».
export function parseFrameLocation(location) {
  const text = String(location || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  // Километраж: «18 км 790 м» / «КМ 18+790» / «4 КМ + 730 М» / «993км + 0м».
  const kmMatch = text.match(/(\d+)\s*км\.?,?\s*\+?\s*(\d+)?\s*м/iu)
    || text.match(/км\s*(\d+)\s*\+\s*(\d+)/iu);
  if (!kmMatch) return null;
  const km = Number(kmMatch[1]) + (Number(kmMatch[2]) || 0) / 1000;
  // Дорога: кусок после «а/д» или «автомобильная дорога …» до конца/запятой
  // с регионом; служебный код учёта («04 ОП РЗ 04K-044») отбрасывается.
  const roadMatch = text.match(/(?:а\/д|автомобильн[а-яё]*\s+дорог[а-яё]*)\s*(.+)$/iu);
  if (!roadMatch) return null;
  let road = roadMatch[1]
    .replace(/(\d+)\s*км\.?,?\s*\+?\s*(\d+)?\s*м\.?/giu, ' ')
    .replace(/км\s*\d+\s*\+\s*\d+/giu, ' ')
    .replace(/\d+\s*ОП\s*[РМ][ЗН]\s*[\w\d./-]+/giu, ' ')
    .replace(/общего пользования (федерального|регионального|местного) значения/giu, ' ')
    .replace(/[«»'"|]/g, ' ');
  // Регион — последний фрагмент после запятой с «область/край/республика/обл.».
  let region = '';
  const parts = road.split(',').map(part => part.trim()).filter(Boolean);
  while (parts.length > 1) {
    const tail = parts[parts.length - 1];
    if (/область|обл\.?$|край$|республик|р-н|район|г\.|авт\. окр/iu.test(tail)) {
      if (!region && /область|обл\.?$|край$|республик/iu.test(tail)) region = tail;
      parts.pop();
    } else break;
  }
  road = parts.join(',').replace(/\s+/g, ' ').replace(/[\s,.]+$/g, '').trim();
  if (!region) {
    const regionMatch = text.match(/,\s*([^,]*(?:область|обл\.?|край|республика[^,]*))\s*[.,]?\s*$/iu);
    region = regionMatch ? regionMatch[1].trim() : '';
  }
  if (!road) return null;
  return { road, km: +km.toFixed(3), region };
}

// Ключ слияния написаний: дорога без регистра/ё/пунктуации + целый км.
export function frameKey(parsed) {
  if (!parsed) return '';
  const road = parsed.road.toLowerCase().replace(/ё/g, 'е')
    .replace(/\b(г|пгт|с|п|д)\.\s*/g, '')
    .replace(/старого направления/g, '')
    .replace(/[^а-яa-z0-9]+/g, '');
  return `${road}|${Math.round(parsed.km)}`;
}

// Концы дороги для геокода: первый и последний топонимы «А - Б - В» → А, В.
export function roadEndpoints(road) {
  const cleaned = String(road || '').replace(/\(.*?\)/g, ' ').replace(/\s+/g, ' ').trim();
  const parts = cleaned.split(/\s*[-–—]\s*/).map(part => part.trim()).filter(part => part.length >= 2);
  if (parts.length >= 2) return [parts[0], parts[parts.length - 1]];
  return [cleaned];
}

export function migrateWeightFrames(db) {
  // Ширина коридора предупреждения (км от прямой маршрута до рамки) —
  // настройка руководителя; дефолт — только вместо пустоты. 0 = выключить.
  const calcRow = db.prepare(`SELECT value_json FROM settings WHERE key='calculation'`).get();
  if (calcRow) {
    const calculation = JSON.parse(calcRow.value_json);
    if (calculation.frameCorridorKm == null) {
      calculation.frameCorridorKm = 15;
      db.prepare(`UPDATE settings SET value_json=? WHERE key='calculation'`)
        .run(JSON.stringify(calculation));
    }
  }
  db.exec(`CREATE TABLE IF NOT EXISTS weight_frames (
    id TEXT PRIMARY KEY,
    frame_key TEXT NOT NULL UNIQUE,
    road TEXT NOT NULL,
    km REAL NOT NULL,
    region TEXT NOT NULL DEFAULT '',
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

// Пересборка справочника из штрафов: новые рамки добавляются, у известных
// обновляются счётчики; координаты и ручное enabled не трогаются.
export function rebuildWeightFrames(db, randomUUID) {
  const rows = db.prepare(`SELECT location, COUNT(*) c, SUM(amount) s, MAX(offense_on) mx
    FROM gibdd_fines WHERE article_number LIKE '%12.21.1%' AND location<>''
    GROUP BY location`).all();
  const byKey = new Map();
  for (const row of rows) {
    const parsed = parseFrameLocation(row.location);
    if (!parsed) continue;
    const key = frameKey(parsed);
    const item = byKey.get(key) || { ...parsed, location: row.location, count: 0, amount: 0, last: '' };
    item.count += row.c;
    item.amount += row.s;
    if (row.mx > item.last) item.last = row.mx;
    // Самое длинное написание — обычно самое информативное.
    if (row.location.length > item.location.length) item.location = row.location;
    byKey.set(key, item);
  }
  const insert = db.prepare(`INSERT INTO weight_frames(id, frame_key, road, km, region, location,
      fines_count, fines_amount, last_offense_on)
    VALUES(?,?,?,?,?,?,?,?,?)
    ON CONFLICT(frame_key) DO UPDATE SET fines_count=excluded.fines_count,
      fines_amount=excluded.fines_amount, last_offense_on=excluded.last_offense_on,
      location=excluded.location, updated_at=CURRENT_TIMESTAMP
    WHERE weight_frames.fines_count<>excluded.fines_count
      OR weight_frames.fines_amount<>excluded.fines_amount`);
  let added = 0;
  const before = db.prepare(`SELECT COUNT(*) c FROM weight_frames`).get().c;
  for (const [key, item] of byKey) {
    insert.run(randomUUID(), key, item.road, item.km, item.region, item.location,
      item.count, item.amount, item.last);
  }
  added = db.prepare(`SELECT COUNT(*) c FROM weight_frames`).get().c - before;
  return { frames: byKey.size, added };
}

// Расстояние от точки до отрезка (км): равнопромежуточная проекция
// относительно средней широты — на плечах до тысячи км точность единицы
// процентов, для коридора предупреждений достаточно.
export function pointToLegKm(point, a, b) {
  const nums = [point.latitude, point.longitude, a.latitude, a.longitude, b.latitude, b.longitude];
  if (!nums.every(Number.isFinite)) return null;
  const latAvg = (a.latitude + b.latitude + point.latitude) / 3 * Math.PI / 180;
  const kmLat = 110.574;
  const kmLon = 111.32 * Math.cos(latAvg);
  const ax = a.longitude * kmLon, ay = a.latitude * kmLat;
  const bx = b.longitude * kmLon, by = b.latitude * kmLat;
  const px = point.longitude * kmLon, py = point.latitude * kmLat;
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq)) : 0;
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

// Рамки в коридоре маршрута A→B: с координатами, включённые, ближе порога.
export function framesNearLeg(db, a, b, corridorKm) {
  if (!corridorKm || !a || !b) return [];
  return db.prepare(`SELECT * FROM weight_frames
      WHERE enabled=1 AND latitude IS NOT NULL AND longitude IS NOT NULL`).all()
    .map(frame => ({ ...frame, awayKm: pointToLegKm(frame, a, b) }))
    .filter(frame => frame.awayKm != null && frame.awayKm <= corridorKm)
    .sort((x, y) => x.awayKm - y.awayKm);
}
