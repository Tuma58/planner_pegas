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
