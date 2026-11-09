// Коннектор «OnlineГИБДД» (api.onlinegibdd.ru/v3) — штрафы ГИБДД по парку
// (заказ руководителя 09.11.2026, проект «Слияние»). Сервис сам собирает
// постановления по СТС+госномеру раз в сутки; планер забирает их по REST
// и ВИНОВНИКА определяет у себя — по закреплениям driver_assignments на
// момент нарушения (наружу уходят только СТС и госномера, водителей и
// периоды ответственности в сервис не передаём).
//
// Источник СТС — «Паспорт ТС» (vehicle_cards.sts_number): машина без СТС
// в карточке на мониторинг не ставится и в сводке честно видна отдельной
// строкой. Ключ API — Настройки → Интеграции (шифруется, как у Dornet).
//
// Разделение с коннектором Dornet (затраты): Dornet кладёт в журнал
// «💸 Затраты» штрафы, ОПЛАЧЕННЫЕ через него (факт списания денег);
// OnlineГИБДД ведёт ПОЛНЫЙ журнал постановлений (неоплаченные, скидки,
// виновники) и в затраты НЕ пишет — иначе одна оплата задвоится.
//
// Живые нормативы: своих бизнес-констант нет. «Скидка горит» — общий
// порог «Сроки документов — предупреждать за, дн» из Настроек (как
// паспорт ТС и допуски БДД).

const MSK_MS = 3 * 3_600_000;

// Госномер планера → номер и регион для API («р901ар58» → Р901АР + 58).
// Тягачи: буква + 3 цифры + 2 буквы; прицепы: 2 буквы + 4 цифры.
const LATIN = 'ABEKMHOPCTYXabekmhopctyx';
const CYR = 'АВЕКМНОРСТУХавекмнорстух';
const toCyr = text => String(text || '').replace(/[A-Za-z]/g, ch => {
  const i = LATIN.indexOf(ch); return i >= 0 ? CYR[i] : ch;
});
export function plateParts(plate) {
  const clean = toCyr(plate).replace(/\s+/g, '').toUpperCase();
  const match = clean.match(/^([АВЕКМНОРСТУХ]\d{3}[АВЕКМНОРСТУХ]{2}|[АВЕКМНОРСТУХ]{2}\d{4}|[АВЕКМНОРСТУХ]{2}\d{3})(\d{2,3})$/);
  return match ? { number: match[1], region: match[2] } : null;
}

// СТС к единому виду для сопоставления: без пробелов, буквы — кириллицей
// в верхнем регистре («99 ав 123456» → «99АВ123456»).
export const normCdi = value => toCyr(value).replace(/\s+/g, '').toUpperCase();

// Момент нарушения: дата + время из постановления — местные часы места
// нарушения. Трактуем как МСК: расхождение с реальным поясом — часы, а
// закрепления водителей живут сутками и неделями, на виновника не влияет.
export function offenseIso(date, time) {
  const day = String(date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const clock = /^\d{2}:\d{2}/.test(String(time || '')) ? String(time).slice(0, 5) : '00:00';
  const ms = Date.parse(`${day}T${clock}:00.000Z`) - MSK_MS;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

// Госномер к виду планера: без пробелов, нижний регистр, кириллица.
const plateKey = value => toCyr(value).replace(/\s+/g, '').toLowerCase();

// Импорт СТС из личного кабинета сервиса в «Паспорт ТС» (руководитель
// 09.11: «ЛК действующий, все СТС в нём» — кабинет и есть источник
// истины). Пустой СТС заполняется по совпадению госномера; заполненный
// не перезаписывается — расхождение решает человек.
export function importSts(db, serviceAutos) {
  const ourCdi = new Set(db.prepare(`SELECT sts_number FROM vehicle_cards
    WHERE sts_number<>''`).all().map(row => normCdi(row.sts_number)));
  const byPlate = new Map(db.prepare('SELECT id, plate FROM vehicles').all()
    .map(vehicle => [plateKey(vehicle.plate), vehicle.id]));
  const fill = db.prepare(`INSERT INTO vehicle_cards(vehicle_id, sts_number, updated_at, updated_by_name)
    VALUES(?, ?, CURRENT_TIMESTAMP, 'OnlineГИБДД')
    ON CONFLICT(vehicle_id) DO UPDATE SET sts_number=excluded.sts_number,
      updated_at=CURRENT_TIMESTAMP, updated_by_name='OnlineГИБДД'
    WHERE vehicle_cards.sts_number=''`);
  let imported = 0;
  for (const auto of serviceAutos || []) {
    const cdi = normCdi(auto?.auto_cdi);
    if (!cdi || ourCdi.has(cdi)) continue;
    const vehicleId = byPlate.get(plateKey(`${auto.auto_number}${auto.auto_region}`));
    if (!vehicleId) continue;
    if (fill.run(vehicleId, cdi).changes) imported += 1;
  }
  return imported;
}

export function migrateGibdd(db) {
  db.prepare(`INSERT OR IGNORE INTO integration_connectors(id,name,base_url)
    VALUES('onlinegibdd','OnlineГИБДД (штрафы)','https://api.onlinegibdd.ru/v3')`).run();
  db.exec(`CREATE TABLE IF NOT EXISTS gibdd_fines (
    bill_id TEXT PRIMARY KEY,
    gis_id INTEGER,
    auto_cdi TEXT NOT NULL DEFAULT '',
    vehicle_id TEXT REFERENCES vehicles(id),
    plate TEXT NOT NULL DEFAULT '',
    driver_id TEXT, driver_name TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'nopayed',
    in_processing TEXT NOT NULL DEFAULT '0',
    bill_date TEXT, pay_due TEXT,
    amount REAL NOT NULL DEFAULT 0,
    discount_pct INTEGER NOT NULL DEFAULT 0, discount_until TEXT,
    amount_discount REAL,
    offense_on TEXT, offense_time TEXT NOT NULL DEFAULT '', offense_at TEXT,
    location TEXT NOT NULL DEFAULT '',
    article_number TEXT NOT NULL DEFAULT '', article TEXT NOT NULL DEFAULT '',
    first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    paid_seen_at TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE INDEX IF NOT EXISTS idx_gibdd_fines_vehicle ON gibdd_fines(vehicle_id, offense_on);
  CREATE INDEX IF NOT EXISTS idx_gibdd_fines_status ON gibdd_fines(status);`);
}

// Ответ partner_fines → плоские строки (чистая функция, тесты).
export function mapApiFines(data) {
  const rows = [];
  for (const auto of Object.values(data?.auto_list || {})) {
    const cdi = normCdi(auto?.auto_cdi);
    for (const fine of Object.values(auto?.offense_list || {})) {
      if (!fine?.bill_id) continue;
      rows.push({
        bill_id: String(fine.bill_id), gis_id: Number(fine.gis_id) || null, auto_cdi: cdi,
        status: fine.gis_status === 'payed' ? 'payed' : 'nopayed',
        in_processing: String(fine.in_processing ?? '0'),
        bill_date: fine.pay_bill_date || null, pay_due: fine.last_bill_date || null,
        amount: Number(fine.pay_bill_amount) || 0,
        discount_pct: Number(fine.gis_discount) || 0,
        discount_until: fine.gis_discount_uptodate || null,
        amount_discount: fine.pay_bill_amount_with_discount != null
          ? Number(fine.pay_bill_amount_with_discount) : null,
        offense_on: fine.offense_date || null,
        offense_time: String(fine.offense_time || ''),
        offense_at: offenseIso(fine.offense_date, fine.offense_time),
        location: String(fine.offense_location || '').slice(0, 300),
        article_number: String(fine.offense_article_number || ''),
        article: String(fine.offense_article || '').slice(0, 300)
      });
    }
  }
  return rows;
}

// Водитель на момент нарушения: закрепление, действовавшее в этот момент;
// фолбэк — текущий водитель машины (как в рейсах и сверке 1С).
export function resolveFineDriver(db, vehicleId, offenseAt) {
  if (!vehicleId) return { driverId: null, driverName: '' };
  if (offenseAt) {
    const row = db.prepare(`SELECT d.id, d.full_name FROM driver_assignments a
        JOIN drivers d ON d.id=a.driver_id
      WHERE a.vehicle_id=? AND datetime(a.starts_at)<=datetime(?)
        AND (a.ends_at IS NULL OR datetime(a.ends_at)>datetime(?))
      ORDER BY a.starts_at DESC LIMIT 1`).get(vehicleId, offenseAt, offenseAt);
    if (row) return { driverId: row.id, driverName: row.full_name };
  }
  const vehicle = db.prepare('SELECT driver_name FROM vehicles WHERE id=?').get(vehicleId);
  return { driverId: null, driverName: vehicle?.driver_name || '' };
}

// Сохранение штрафов: ключ — номер постановления (УИН), повторная
// синхронизация обновляет статус и суммы, дублей не создаёт. Водитель
// резолвится при первой встрече и при пустом виновнике (закрепления
// могли дозаписать задним числом).
export function upsertGibddFines(db, rows) {
  const byCdi = new Map(db.prepare(`SELECT c.vehicle_id, c.sts_number, v.plate
      FROM vehicle_cards c JOIN vehicles v ON v.id=c.vehicle_id
      WHERE c.sts_number<>''`).all().map(row => [normCdi(row.sts_number), row]));
  const get = db.prepare('SELECT bill_id, status, driver_id, driver_name FROM gibdd_fines WHERE bill_id=?');
  const insert = db.prepare(`INSERT INTO gibdd_fines(bill_id,gis_id,auto_cdi,vehicle_id,plate,
      driver_id,driver_name,status,in_processing,bill_date,pay_due,amount,discount_pct,
      discount_until,amount_discount,offense_on,offense_time,offense_at,location,
      article_number,article,paid_seen_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const update = db.prepare(`UPDATE gibdd_fines SET status=?, in_processing=?, amount=?,
      discount_pct=?, discount_until=?, amount_discount=?, pay_due=?,
      driver_id=COALESCE(driver_id,?), driver_name=CASE WHEN driver_name='' THEN ? ELSE driver_name END,
      paid_seen_at=CASE WHEN paid_seen_at IS NULL AND ?='payed' THEN CURRENT_TIMESTAMP ELSE paid_seen_at END,
      updated_at=CURRENT_TIMESTAMP
    WHERE bill_id=? AND (status<>? OR in_processing<>? OR amount<>? OR driver_name='')`);
  const stats = { added: 0, updated: 0, paidNew: 0, unknownCdi: new Set() };
  for (const row of rows) {
    const car = byCdi.get(row.auto_cdi);
    if (!car) stats.unknownCdi.add(row.auto_cdi);
    const existing = get.get(row.bill_id);
    if (!existing) {
      const driver = resolveFineDriver(db, car?.vehicle_id || null, row.offense_at);
      insert.run(row.bill_id, row.gis_id, row.auto_cdi, car?.vehicle_id || null, car?.plate || '',
        driver.driverId, driver.driverName, row.status, row.in_processing, row.bill_date,
        row.pay_due, row.amount, row.discount_pct, row.discount_until, row.amount_discount,
        row.offense_on, row.offense_time, row.offense_at, row.location,
        row.article_number, row.article, row.status === 'payed' ? new Date().toISOString() : null);
      stats.added += 1;
      if (row.status === 'payed') stats.paidNew += 1;
    } else {
      const driver = existing.driver_name ? { driverId: existing.driver_id, driverName: existing.driver_name }
        : resolveFineDriver(db, car?.vehicle_id || null, row.offense_at);
      const result = update.run(row.status, row.in_processing, row.amount,
        row.discount_pct, row.discount_until, row.amount_discount, row.pay_due,
        driver.driverId, driver.driverName, row.status,
        row.bill_id, row.status, row.in_processing, row.amount);
      if (result.changes) {
        stats.updated += 1;
        if (row.status === 'payed' && existing.status !== 'payed') stats.paidNew += 1;
      }
    }
  }
  return { ...stats, unknownCdi: [...stats.unknownCdi].filter(Boolean) };
}

// Свод для экрана БДД: журнал за период (по дате нарушения) + все
// неоплаченные (как открытые расследования — видны всегда).
export function gibddBoard(db, { from, to, warnDays, nowMs = Date.now() }) {
  const today = new Date(nowMs + MSK_MS).toISOString().slice(0, 10);
  const warnTo = new Date(Date.parse(`${today}T00:00:00Z`) + warnDays * 864e5).toISOString().slice(0, 10);
  const fines = db.prepare(`SELECT * FROM gibdd_fines
      WHERE offense_on>=? AND offense_on<=? ORDER BY offense_on DESC, offense_time DESC`).all(from, to);
  const unpaid = db.prepare(`SELECT * FROM gibdd_fines WHERE status='nopayed'
      ORDER BY COALESCE(discount_until,'9999') , offense_on`).all();
  const burning = unpaid.filter(fine => fine.discount_until
    && fine.discount_until >= today && fine.discount_until <= warnTo);
  const overdue = unpaid.filter(fine => fine.pay_due && fine.pay_due < today);
  const byDriver = new Map();
  for (const fine of fines) {
    const key = fine.driver_name || '— без виновника —';
    const item = byDriver.get(key) || { name: key, count: 0, amount: 0 };
    item.count += 1;
    item.amount += fine.amount;
    byDriver.set(key, item);
  }
  return {
    fines, burning,
    unpaidCount: unpaid.length,
    unpaidAmount: +unpaid.reduce((sum, fine) => sum + (fine.amount_discount != null
      && fine.discount_until && fine.discount_until >= today ? fine.amount_discount : fine.amount), 0).toFixed(2),
    overdueCount: overdue.length,
    byDriver: [...byDriver.values()].sort((a, b) => b.amount - a.amount).slice(0, 30),
    withoutSts: db.prepare(`SELECT v.plate FROM vehicles v
        LEFT JOIN vehicle_cards c ON c.vehicle_id=v.id
      WHERE v.status<>'out' AND COALESCE(c.sts_number,'')=''
      ORDER BY v.plate`).all().map(row => row.plate)
  };
}
