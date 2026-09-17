// Новый график работы и закрепления водителей (перестройка Ресурса,
// этап 1, утверждён руководителем 17.09.2026). Страница — перенесённый
// прототип руководителя (src/pages/schedule.html|js); хранение — экипаж
// целиком JSON-блоком (schedule_crews) + журнал правок (schedule_log);
// обмен — протокол прототипа: POST /api/schedule/sync
// {since, crews{}, remove[], log[]} → {rev, crews с rev>since, log}.
// Экипаж: {id, ts:[{id,tyagach,pricep,tip,filial,crew}],
//          drv:[{id,fio,tel,crew,filial,ts,rezhim,logist,vac,plan{},fact{}}]}.
// Нормализация в таблицы планера — этап 2 (мосты), сейчас блок автономен:
// оперативная работа старой вкладки не задета ничем.
import { randomUUID } from 'node:crypto';

const metaGet = (db, key) => db.prepare('SELECT value FROM app_meta WHERE key=?').get(key)?.value;
const metaSet = (db, key, value) => db.prepare(`INSERT INTO app_meta(key,value) VALUES(?,?)
  ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, String(value));

// Один вызов обмена: принять изменения клиента (last-write-wins по
// экипажу), вернуть чужие изменения после since. Всё одной транзакцией.
export function applyScheduleSync(db, body = {}, userId = null) {
  const since = Number(body.since) || 0;
  const crews = body.crews && typeof body.crews === 'object' ? body.crews : {};
  const remove = Array.isArray(body.remove) ? body.remove : [];
  const log = Array.isArray(body.log) ? body.log : [];
  for (const [id, crew] of Object.entries(crews)) {
    if (!crew || typeof crew !== 'object' || !Array.isArray(crew.ts) || !Array.isArray(crew.drv)) {
      throw Object.assign(new Error(`Экипаж ${id}: ожидаю {id, ts[], drv[]}`), { status: 422 });
    }
  }
  db.exec('BEGIN IMMEDIATE');
  let rev;
  try {
    rev = Number(metaGet(db, 'schedule_rev') || 0);
    if (Object.keys(crews).length || remove.length || log.length) {
      rev += 1;
      const upsert = db.prepare(`INSERT INTO schedule_crews(id,body,rev,updated_by,updated_at)
        VALUES(?,?,?,?,CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET body=excluded.body, rev=excluded.rev,
          updated_by=excluded.updated_by, updated_at=CURRENT_TIMESTAMP`);
      for (const [id, crew] of Object.entries(crews)) {
        upsert.run(String(id).slice(0, 40), JSON.stringify(crew), rev, userId);
      }
      const drop = db.prepare('DELETE FROM schedule_crews WHERE id=?');
      for (const id of remove) drop.run(String(id).slice(0, 40));
      const addLog = db.prepare(`INSERT INTO schedule_log(t,author,what,who,rev,user_id)
        VALUES(?,?,?,?,?,?)`);
      for (const entry of log.slice(0, 400)) {
        addLog.run(String(entry.t || new Date().toISOString()).slice(0, 40),
          String(entry.a || '').slice(0, 80), String(entry.what || '').slice(0, 400),
          String(entry.who || '').slice(0, 120), rev, userId);
      }
      // Журнал не растёт бесконечно: как в прототипе, живут последние 800.
      db.prepare(`DELETE FROM schedule_log WHERE id NOT IN
        (SELECT id FROM schedule_log ORDER BY id DESC LIMIT 800)`).run();
      metaSet(db, 'schedule_rev', rev);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  const outCrews = {};
  for (const row of db.prepare('SELECT id, body FROM schedule_crews WHERE rev > ?').all(since)) {
    try { outCrews[row.id] = JSON.parse(row.body); } catch { /* битый блок не отдаём */ }
  }
  const outLog = db.prepare(`SELECT t, author a, what, who FROM schedule_log
    WHERE rev > ? ORDER BY id DESC LIMIT 400`).all(since);
  return { rev, crews: outCrews, log: outLog };
}

// ── Этап 2 перестройки: мосты график ↔ оперативный планер ──────────
// Направления выбраны без циклов: план людей ЖИВЁТ в графике и
// транслируется в диспозиции планера (пересменки — их читают подбор ТС,
// гант, сторожа); факт работы ЖИВЁТ в планере (рейсы/перегоны) и
// подтверждает факт-слой графика. Обратных записей нет.

const dayIso = (base, offset) =>
  new Date(base + offset * 86_400_000).toISOString().slice(0, 10);
const canonPlate = value => String(value || '').toLowerCase().replace(/\s+/g, '');
const tail3 = plate => (String(plate).match(/\d{3}/) || [''])[0];

function loadCrews(db, ids = null) {
  const rows = ids
    ? ids.map(id => db.prepare('SELECT id, body FROM schedule_crews WHERE id=?').get(id)).filter(Boolean)
    : db.prepare('SELECT id, body FROM schedule_crews').all();
  const out = new Map();
  for (const row of rows) {
    try { out.set(row.id, JSON.parse(row.body)); } catch { /* битый блок пропускаем */ }
  }
  return out;
}

// Код дня водителя из план-слоя. r = {mk, d} не нужен: день ISO.
const planCode = (drv, iso) => {
  const arr = (drv.plan || {})[iso.slice(0, 7)];
  return arr ? String(arr[Number(iso.slice(8, 10)) - 1] || '') : '';
};
const factCode = (drv, iso) => {
  const arr = (drv.fact || {})[iso.slice(0, 7)];
  return arr ? String(arr[Number(iso.slice(8, 10)) - 1] || '') : '';
};
const setFact = (drv, iso, code) => {
  drv.fact = drv.fact || {};
  const mk = iso.slice(0, 7);
  if (!drv.fact[mk]) {
    const days = new Date(Number(mk.slice(0, 4)), Number(mk.slice(5, 7)), 0).getDate();
    drv.fact[mk] = Array(days).fill('');
  }
  drv.fact[mk][Number(iso.slice(8, 10)) - 1] = code;
};

// Мост «П в плане → пересменка-диспозиция машины» для изменённых
// экипажей. Создаёт shift-сутки с пометкой «из графика», убирает свои
// же пометки, если П сняли; ручные интервалы старой вкладки не трогает,
// при пересечении с любой существующей диспозицией — день пропускает.
export function syncShiftBridge(db, crewIds, userId = null, horizonDays = 35) {
  const crews = loadCrews(db, crewIds);
  if (!crews.size) return { created: 0, removed: 0 };
  const vehicleByPlate = new Map(db.prepare(`SELECT id, plate FROM vehicles`).all()
    .map(row => [canonPlate(row.plate), row.id]));
  const todayMs = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  const result = { created: 0, removed: 0 };
  for (const crew of crews.values()) {
    for (const ts of crew.ts || []) {
      const vehicleId = vehicleByPlate.get(canonPlate(ts.tyagach));
      if (!vehicleId) continue;
      // Желаемые дни пересменки: П/РП у СВОЕГО водителя этой машины.
      const want = new Map();
      for (const drv of crew.drv || []) {
        if (drv.ts !== ts.id) continue;
        for (let offset = 0; offset < horizonDays; offset += 1) {
          const iso = dayIso(todayMs, offset);
          if (['П', 'РП'].includes(planCode(drv, iso))) want.set(iso, drv.fio);
        }
      }
      const horizonIso = dayIso(todayMs, horizonDays);
      const existing = db.prepare(`SELECT id, starts_at, ends_at, note FROM vehicle_dispositions
        WHERE vehicle_id=? AND kind='shift' AND starts_at < ? AND ends_at > ?`)
        .all(vehicleId, `${horizonIso}T00:00:00.000Z`, new Date(todayMs).toISOString());
      const mine = existing.filter(item => String(item.note).startsWith('из графика'));
      const mineByDay = new Map(mine.map(item => [String(item.starts_at).slice(0, 10), item]));
      for (const [iso, fio] of want) {
        if (mineByDay.has(iso)) continue;
        const dayStart = `${iso}T00:00:00.000Z`;
        const dayEnd = new Date(Date.parse(dayStart) + 86_400_000).toISOString();
        // Любая существующая диспозиция в этих сутках — день не наш.
        const busy = db.prepare(`SELECT 1 FROM vehicle_dispositions
          WHERE vehicle_id=? AND starts_at < ? AND ends_at > ? LIMIT 1`)
          .get(vehicleId, dayEnd, dayStart);
        if (busy) continue;
        db.prepare(`INSERT INTO vehicle_dispositions(id,vehicle_id,kind,starts_at,ends_at,note,purpose,created_by,updated_by)
          VALUES(?,?,?,?,?,?,'',?,?)`).run(randomUUID(), vehicleId, 'shift',
          dayStart, dayEnd, `из графика: ${String(fio).split(/\s+/)[0]}`, userId, userId);
        result.created += 1;
      }
      for (const item of mine) {
        const iso = String(item.starts_at).slice(0, 10);
        if (!want.has(iso)) {
          db.prepare('DELETE FROM vehicle_dispositions WHERE id=?').run(item.id);
          result.removed += 1;
        }
      }
    }
  }
  return result;
}

// Автофакт: рейс или перегон машины в день D подтверждает факт-слой
// того, кто по ПЛАНУ был за рулём (свой водитель с «в»/«П»/«РП» или
// замещающий по хвосту номера). Пустая клетка факта получает плановый
// код; занятую руками не трогаем; «двое на машине» — пропуск.
export function runScheduleAutoFact(db, userId = null, daysBack = 3) {
  const crews = loadCrews(db);
  if (!crews.size) return { marks: 0 };
  const todayMs = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  const fromIso = new Date(todayMs - daysBack * 86_400_000).toISOString();
  const nowIso = new Date().toISOString();
  const busyByVehicle = new Map();
  const markBusy = (vehicleId, fromMs, toMs) => {
    if (!busyByVehicle.has(vehicleId)) busyByVehicle.set(vehicleId, []);
    busyByVehicle.get(vehicleId).push([fromMs, toMs]);
  };
  for (const trip of db.prepare(`SELECT vehicle_id, starts_at, ends_at, unloaded_at, status
      FROM trips WHERE status<>'rejected' AND starts_at < ? AND COALESCE(unloaded_at, ends_at) > ?`)
    .all(nowIso, fromIso)) {
    const from = Date.parse(trip.starts_at);
    const rawTo = trip.unloaded_at ? Date.parse(trip.unloaded_at)
      : ['plan', 'run'].includes(trip.status)
        ? Math.max(Date.parse(trip.ends_at), Date.now()) : Date.parse(trip.ends_at);
    markBusy(trip.vehicle_id, from, rawTo);
  }
  for (const move of db.prepare(`SELECT vehicle_id, starts_at, ends_at FROM vehicle_dispositions
      WHERE kind='transfer' AND starts_at < ? AND ends_at > ?`).all(nowIso, fromIso)) {
    markBusy(move.vehicle_id, Date.parse(move.starts_at), Date.parse(move.ends_at));
  }
  const vehicleByPlate = new Map(db.prepare('SELECT id, plate FROM vehicles').all()
    .map(row => [canonPlate(row.plate), row.id]));
  const touched = new Set();
  let marks = 0;
  // Покрытие обкатки: сколько машино-дней с работой план назвал
  // однозначно — гейт этапа 3 (замер руководителю каждое утро).
  const counters = { busyDays: 0, noHolder: 0, many: 0, already: 0 };
  for (const crew of crews.values()) {
    for (const ts of crew.ts || []) {
      const vehicleId = vehicleByPlate.get(canonPlate(ts.tyagach));
      const spans = vehicleId ? busyByVehicle.get(vehicleId) : null;
      if (!spans) continue;
      for (let offset = 0; offset <= daysBack; offset += 1) {
        const iso = dayIso(todayMs, -offset);
        const dayStart = Date.parse(`${iso}T00:00:00Z`);
        if (!spans.some(([from, to]) => from < dayStart + 86_400_000 && to > dayStart)) continue;
        // Кто за рулём по плану: свой водитель или замещающий по хвосту.
        const holders = [];
        for (const other of crews.values()) {
          for (const drv of other.drv || []) {
            const code = planCode(drv, iso);
            if ((drv.ts === ts.id && ['в', 'П', 'РП'].includes(code)) ||
                (code && code === tail3(ts.tyagach))) {
              holders.push({ crew: other, drv, code });
            }
          }
        }
        counters.busyDays += 1;
        if (!holders.length) { counters.noHolder += 1; continue; }
        if (holders.length > 1) { counters.many += 1; continue; }
        const { crew: holderCrew, drv, code } = holders[0];
        if (factCode(drv, iso)) { counters.already += 1; continue; }
        setFact(drv, iso, code);
        touched.add(holderCrew.id);
        marks += 1;
      }
    }
  }
  if (touched.size) {
    const snapshot = Object.fromEntries([...crews].filter(([id]) => touched.has(id)));
    applyScheduleSync(db, {
      since: Number(metaGet(db, 'schedule_rev') || 0),
      crews: snapshot,
      log: [{ t: new Date().toISOString(), a: 'планер',
        what: `автофакт: рейсы и перегоны подтвердили ${marks} отметок факта` }]
    }, userId);
  }
  return { marks, ...counters };
}

// Достройка из планера (решение руководителя 17.09: «данные по ТС и
// водителям достраиваем из планера»). Идемпотентна: добавляет только
// то, чего в графике нет. Машины планера вне графика — в экипаж
// «Резерв» (руководитель раскидает по экипажам в самом графике);
// активные водители планера вне графика — в экипаж их машины.
export function augmentScheduleFromPlanner(db, userId = null) {
  const rows = db.prepare('SELECT id, body FROM schedule_crews').all();
  if (!rows.length) return { added: 0, note: 'график пуст — сначала посев' };
  const crews = new Map(rows.map(row => [row.id, JSON.parse(row.body)]));
  const canon = value => String(value || '').toLowerCase().replace(/\s+/g, '');
  const tsByPlate = new Map();
  const crewByTsId = new Map();
  let maxT = 0;
  let maxD = 0;
  for (const crew of crews.values()) {
    for (const ts of crew.ts || []) {
      tsByPlate.set(canon(ts.tyagach), ts);
      crewByTsId.set(ts.id, crew);
      maxT = Math.max(maxT, Number(String(ts.id).replace(/\D/g, '')) || 0);
    }
    for (const drv of crew.drv || []) {
      maxD = Math.max(maxD, Number(String(drv.id).replace(/\D/g, '')) || 0);
    }
  }
  // Сличение людей: полное ФИО, а при сокращённой записи в графике
  // («Тулчин Олег» против «Тулчин Олег Иванович» в планере) — по
  // «Фамилия Имя», только когда такая пара однозначна с обеих сторон.
  // Суффиксы-пометки в скобках («(н)») в сравнении не участвуют.
  const fioWords = value => String(value || '').toLowerCase()
    .replace(/\([^)]*\)/g, ' ').split(/\s+/).filter(Boolean);
  const canonFio = value => fioWords(value).join(' ');
  const pairOf = value => fioWords(value).slice(0, 2).join(' ');
  const fioSet = new Set();
  const pairCount = new Map();
  const monthKeys = new Set();
  for (const crew of crews.values()) {
    for (const drv of crew.drv || []) {
      if (drv.vac) continue;
      fioSet.add(canonFio(drv.fio));
      const pair = pairOf(drv.fio);
      if (pair) pairCount.set(pair, (pairCount.get(pair) || 0) + 1);
      for (const layer of ['plan', 'fact']) {
        Object.keys(drv[layer] || {}).forEach(key => monthKeys.add(key));
      }
    }
  }
  // Пустые ленты всех месяцев графика: клиентская сетка ждёт массив дней
  // у каждого водителя, добавленный без лент ронял бы рендер и кисть.
  const daysIn = key => new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)), 0).getDate();
  const blankLayers = () => {
    const plan = {};
    const fact = {};
    for (const key of monthKeys) {
      plan[key] = Array(daysIn(key)).fill('');
      fact[key] = Array(daysIn(key)).fill('');
    }
    return { plan, fact };
  };
  const report = { addedVehicles: [], addedDrivers: [], fixes: [] };
  const touched = new Set();
  // Опечатка исходного файла: т492ат58 нет в парке, на проде — т492ве58.
  const typo = tsByPlate.get('т492ат58');
  if (typo && !tsByPlate.get('т492ве58') &&
      db.prepare(`SELECT 1 FROM vehicles WHERE LOWER(REPLACE(plate,' ',''))='т492ве58'`).get()) {
    typo.tyagach = 'т492ве58';
    tsByPlate.set('т492ве58', typo);
    report.fixes.push('т492ат58 → т492ве58');
    touched.add(typo.crew);
  }
  let reserve = crews.get('E-RES') || null;
  const ensureReserve = () => {
    if (reserve) return reserve;
    reserve = { id: 'E-RES', ts: [], drv: [] };
    crews.set(reserve.id, reserve);
    return reserve;
  };
  const vehicles = db.prepare(`SELECT v.id, v.plate, v.trailer_plate, t.name type_name
    FROM vehicles v LEFT JOIN vehicle_types t ON t.id=v.type_id
    WHERE v.status<>'out'`).all();
  for (const vehicle of vehicles) {
    if (tsByPlate.has(canon(vehicle.plate))) continue;
    const crew = ensureReserve();
    const ts = { id: `T${++maxT}`, tyagach: vehicle.plate,
      pricep: vehicle.trailer_plate || '', tip: String(vehicle.type_name || '').slice(0, 12),
      filial: 'Пенза', crew: crew.id };
    crew.ts.push(ts);
    tsByPlate.set(canon(vehicle.plate), ts);
    crewByTsId.set(ts.id, crew);
    report.addedVehicles.push(vehicle.plate);
    touched.add(crew.id);
  }
  const drivers = db.prepare(`SELECT d.full_name, d.phone, v.plate FROM drivers d
    LEFT JOIN vehicles v ON v.id=d.vehicle_id WHERE d.status<>'fired'`).all();
  const plannerPairCount = new Map();
  for (const driver of drivers) {
    const pair = pairOf(driver.full_name);
    if (pair) plannerPairCount.set(pair, (plannerPairCount.get(pair) || 0) + 1);
  }
  for (const driver of drivers) {
    if (fioSet.has(canonFio(driver.full_name))) continue;
    const pair = pairOf(driver.full_name);
    if (pair && pairCount.get(pair) === 1 && plannerPairCount.get(pair) === 1) continue;
    const ts = driver.plate ? tsByPlate.get(canon(driver.plate)) : null;
    const crew = ts ? crewByTsId.get(ts.id) : ensureReserve();
    crew.drv.push({ id: `D${++maxD}`, fio: driver.full_name, tel: driver.phone || '',
      crew: crew.id, filial: ts?.filial || 'Пенза', ts: ts?.id || '',
      rezhim: '', logist: '', vac: false, ...blankLayers() });
    fioSet.add(canonFio(driver.full_name));
    report.addedDrivers.push(driver.full_name);
    touched.add(crew.id);
  }
  if (touched.size) {
    applyScheduleSync(db, {
      since: Number(metaGet(db, 'schedule_rev') || 0),
      crews: Object.fromEntries([...crews].filter(([id]) => touched.has(id))),
      log: [{ t: new Date().toISOString(), a: 'планер',
        what: `достройка из планера: машин +${report.addedVehicles.length}, ` +
          `водителей +${report.addedDrivers.length}` +
          (report.fixes.length ? `, исправления: ${report.fixes.join(', ')}` : '') }]
    }, userId);
  }
  return report;
}
