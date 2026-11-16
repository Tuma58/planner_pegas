// 📥 История ТОиР из 1С:УАТ (заказ руководителя 14.11.2026: «загрузка
// истории ремонтов и отработка процессов по всему планеру»).
// Выгрузка подготовлена под планер: «Назначение/Статус (как в планере)»
// совпадают со справочниками Ремзоны.
//
// Куда ложится:
// - заявки на ремонт → repair_orders (очередь/процесс Ремзоны) — только
//   по машинам из справочника (тягачи; прицепов в vehicles нет) +
//   работы → repair_jobs с детерминированным id (идемпотентно);
// - ремонтные листы (деньги, часы, вехи) → repair_sheets — ВСЯ история,
//   включая прицепы (госномер текстом, vehicle_id — когда сматчился).
// Ключ идемпотентности — номер документа 1С: повторная выгрузка
// обновляет, не дублирует. Живые нормативы (медиана срока ремонта
// repairDays, «от заявки до заезда», факт последнего ТО) начинают
// считаться из этих фактов сами — их формулы уже читают repair_orders.
import { randomUUID } from 'node:crypto';

export function migrateToirImport(db) {
  const have = new Set(db.prepare(`PRAGMA table_info(repair_orders)`).all().map(column => column.name));
  if (!have.has('external_no')) db.exec(`ALTER TABLE repair_orders ADD COLUMN external_no TEXT NOT NULL DEFAULT ''`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_repair_orders_external ON repair_orders(external_no)`);
  db.exec(`CREATE TABLE IF NOT EXISTS repair_sheets (
    id TEXT PRIMARY KEY,
    external_no TEXT NOT NULL UNIQUE,
    vehicle_id TEXT REFERENCES vehicles(id),
    plate TEXT NOT NULL DEFAULT '',
    vehicle_kind TEXT NOT NULL DEFAULT '',
    month TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT '',
    group_kind TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT '',
    started_at TEXT, finished_at TEXT, hours REAL,
    odometer_km REAL,
    works_rub REAL NOT NULL DEFAULT 0,
    parts_stock_rub REAL NOT NULL DEFAULT 0,
    outsourced_rub REAL NOT NULL DEFAULT 0,
    parts_bought_rub REAL NOT NULL DEFAULT 0,
    tires_rub REAL NOT NULL DEFAULT 0,
    wash_rub REAL NOT NULL DEFAULT 0,
    total_rub REAL NOT NULL DEFAULT 0,
    pay_kind TEXT NOT NULL DEFAULT '',
    request_key TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_repair_sheets_vehicle ON repair_sheets(vehicle_id, started_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_repair_sheets_month ON repair_sheets(month)`);
}

// Госномер к виду планера (латиница→кириллица, без пробелов, нижний).
const LATIN = 'ABEKMHOPCTYXabekmhopctyx';
const CYR = 'АВЕКМНОРСТУХавекмнорстух';
const normPlate = value => String(value || '')
  .replace(/[A-Za-z]/g, ch => { const i = LATIN.indexOf(ch); return i >= 0 ? CYR[i] : ch; })
  .replace(/\s+/g, '').toLowerCase();

// Эксель-серийная дата (время 1С — московское) → ISO UTC.
export const serialToIso = value => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 20000 || n > 60000) {
    // Уже ISO/дата текстом — принимаем как есть.
    const ms = Date.parse(String(value || ''));
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  return new Date(Math.round((n - 25569) * 864e5) - 3 * 3_600_000).toISOString();
};

const REQUEST_STATUSES = new Set(['queued', 'in_progress', 'ready', 'released', 'cancelled']);

// Заявки на ремонт → repair_orders + работы → repair_jobs.
export function importRepairRequests(db, requests, works, nowIso = new Date().toISOString()) {
  const byPlate = new Map(db.prepare(`SELECT id, plate FROM vehicles`).all()
    .map(row => [normPlate(row.plate), row]));
  const find = db.prepare(`SELECT id, status FROM repair_orders WHERE external_no=?`);
  const insert = db.prepare(`INSERT INTO repair_orders(id,vehicle_id,status,purpose,complaint,odometer_km,
      planned_out,arrived_at,work_started_at,finished_at,released_at,note,external_no,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const update = db.prepare(`UPDATE repair_orders SET vehicle_id=?, status=?, purpose=?, complaint=?,
      odometer_km=?, planned_out=?, arrived_at=?, work_started_at=?, finished_at=?, released_at=?, note=?,
      updated_at=? WHERE id=?`);
  let added = 0, updated = 0;
  const skipped = [];
  const orderIdByNo = new Map();
  for (const row of Array.isArray(requests) ? requests : []) {
    const externalNo = String(row.externalNo || '').trim();
    if (!externalNo) { skipped.push('(заявка без номера)'); continue; }
    const vehicle = byPlate.get(normPlate(row.plate));
    if (!vehicle) { skipped.push(`${externalNo}: нет борта «${String(row.plate || '').trim()}» (прицеп — история в РЛ)`); continue; }
    const status = REQUEST_STATUSES.has(String(row.status)) ? String(row.status)
      : /выполн/i.test(String(row.status1c || '')) ? 'released'
        : /отклон/i.test(String(row.status1c || '')) ? 'cancelled' : 'queued';
    const complaint = [row.complaint, row.defects, row.recommendations].map(v => String(v || '').trim())
      .filter(Boolean).filter((v, i, arr) => arr.indexOf(v) === i).join('\n').slice(0, 2000);
    const note = String(row.note || '').trim().slice(0, 500);
    const odometer = Number(row.odometerKm) > 0 ? Number(row.odometerKm) : null;
    const args = [vehicle.id, status, String(row.purpose || 'прочее').slice(0, 60) || 'прочее',
      complaint, odometer, serialToIso(row.plannedOut), serialToIso(row.arrivedAt),
      serialToIso(row.workStartedAt), serialToIso(row.finishedAt),
      status === 'released' ? serialToIso(row.releasedAt) || serialToIso(row.finishedAt) : null, note];
    const existing = find.get(externalNo);
    if (existing) {
      update.run(...args, nowIso, existing.id);
      orderIdByNo.set(externalNo, existing.id);
      updated += 1;
    } else {
      const id = randomUUID();
      insert.run(id, ...args, externalNo, serialToIso(row.createdAt) || nowIso);
      orderIdByNo.set(externalNo, id);
      added += 1;
    }
  }
  // Работы: детерминированный id «1c-номер-строка» — повтор заменяет.
  const putJob = db.prepare(`INSERT OR REPLACE INTO repair_jobs(id,order_id,title,status,done_at,created_at)
    VALUES(?,?,?,?,?,?)`);
  let jobs = 0;
  for (const row of Array.isArray(works) ? works : []) {
    const orderId = orderIdByNo.get(String(row.externalNo || '').trim());
    const title = String(row.title || '').trim().slice(0, 300);
    if (!orderId || !title) continue;
    const confirmed = /да/i.test(String(row.confirmed || ''));
    putJob.run(`1c-${String(row.externalNo).trim()}-${row.line || 1}`, orderId, title,
      confirmed ? 'done' : 'todo', confirmed ? nowIso : null, nowIso);
    jobs += 1;
  }
  return { added, updated, jobs, skipped };
}

// Ремонтные листы → repair_sheets (вся денежная история, с прицепами).
export function importRepairSheets(db, sheets) {
  const byPlate = new Map(db.prepare(`SELECT id, plate FROM vehicles`).all()
    .map(row => [normPlate(row.plate), row]));
  const upsert = db.prepare(`INSERT INTO repair_sheets(id,external_no,vehicle_id,plate,vehicle_kind,month,kind,
      group_kind,status,started_at,finished_at,hours,odometer_km,works_rub,parts_stock_rub,outsourced_rub,
      parts_bought_rub,tires_rub,wash_rub,total_rub,pay_kind,request_key)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(external_no) DO UPDATE SET vehicle_id=excluded.vehicle_id, plate=excluded.plate,
      vehicle_kind=excluded.vehicle_kind, month=excluded.month, kind=excluded.kind,
      group_kind=excluded.group_kind, status=excluded.status, started_at=excluded.started_at,
      finished_at=excluded.finished_at, hours=excluded.hours, odometer_km=excluded.odometer_km,
      works_rub=excluded.works_rub, parts_stock_rub=excluded.parts_stock_rub,
      outsourced_rub=excluded.outsourced_rub, parts_bought_rub=excluded.parts_bought_rub,
      tires_rub=excluded.tires_rub, wash_rub=excluded.wash_rub, total_rub=excluded.total_rub,
      pay_kind=excluded.pay_kind, request_key=excluded.request_key`);
  let count = 0;
  const skipped = [];
  const num = value => Number(value) || 0;
  for (const row of Array.isArray(sheets) ? sheets : []) {
    const externalNo = String(row.externalNo || '').trim();
    if (!externalNo) { skipped.push('(РЛ без номера)'); continue; }
    const plate = String(row.plate || '').trim();
    upsert.run(randomUUID(), externalNo, byPlate.get(normPlate(plate))?.id || null, plate,
      String(row.vehicleKind || '').slice(0, 20), String(row.month || '').slice(0, 7),
      String(row.kind || '').slice(0, 80), String(row.groupKind || '').slice(0, 40),
      String(row.status || '').slice(0, 40), serialToIso(row.startedAt), serialToIso(row.finishedAt),
      Number.isFinite(Number(row.hours)) ? Number(row.hours) : null,
      num(row.odometerKm) > 0 ? num(row.odometerKm) : null,
      num(row.worksRub), num(row.partsStockRub), num(row.outsourcedRub), num(row.partsBoughtRub),
      num(row.tiresRub), num(row.washRub), num(row.totalRub),
      String(row.payKind || '').slice(0, 40), String(row.requestKey || '').slice(0, 60));
    count += 1;
  }
  return { count, skipped };
}

// Сводка истории ТОиР для вкладки «Ремзона»: месяцы × статьи, итоги по
// группам, топ бортов. Деньги показывает экран по правам — здесь только
// сборка данных.
export function toirHistoryBoard(db, { months = 6 } = {}) {
  const byMonth = db.prepare(`SELECT month, group_kind, COUNT(*) n, SUM(total_rub) rub
    FROM repair_sheets WHERE month<>'' GROUP BY month, group_kind
    ORDER BY month DESC`).all();
  const monthKeys = [...new Set(byMonth.map(row => row.month))].slice(0, months);
  const topVehicles = db.prepare(`SELECT plate, vehicle_kind, COUNT(*) n, SUM(total_rub) rub,
      SUM(hours) hours FROM repair_sheets GROUP BY plate ORDER BY rub DESC LIMIT 15`).all();
  const totals = db.prepare(`SELECT COUNT(*) n, SUM(total_rub) rub, MIN(month) mn, MAX(month) mx
    FROM repair_sheets`).get();
  return {
    months: monthKeys.map(month => ({
      month,
      groups: byMonth.filter(row => row.month === month)
        .map(row => ({ group: row.group_kind || '—', n: row.n, rub: Math.round(row.rub) }))
    })),
    topVehicles: topVehicles.map(row => ({ ...row, rub: Math.round(row.rub) })),
    totals: { ...totals, rub: Math.round(totals.rub || 0) }
  };
}
