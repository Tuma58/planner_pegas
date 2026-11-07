// «Документы» — возврат документов рейса после выгрузки (процесс П5
// «Закрытие рейса и учёт», чек-лист продукта 07.11.2026: хвост услуги
// после выгрузки не был замкнут). Этап «документы получены» в доске
// диспетчера отменён 27.08 — он затягивал контроль. Здесь он возвращается
// ПОСЛЕ контроля и не задерживает закрытие рейса: ведёт диспетчер учёта
// (Эксплуатация), бухгалтерия видит — сданные документы условие оплаты.
// Отдельная отметка docs_returned_at (прежняя docs_checked_at остаётся
// исторической — её трогает доска и факты движения). Учёт — с момента
// включения (метка docs_return_since), старые рейсы задачами не всплывают.
// Норматив сдачи — ЖИВОЙ: медиана «выгрузка → документы сданы» за 60 дней
// (минимум 5 образцов); пока фактов мало — без норматива, просто дни.

export const DOC_KINDS = { originals: 'Оригиналы ТТН/ТН', etrn: 'ЭТрН (электронно)', scan: 'Скан, оригиналы в пути' };

export function migrateTripDocs(db) {
  const cols = db.prepare(`PRAGMA table_info(trips)`).all().map(col => col.name);
  if (!cols.includes('docs_returned_at')) db.exec(`ALTER TABLE trips ADD COLUMN docs_returned_at TEXT`);
  if (!cols.includes('docs_kind')) db.exec(`ALTER TABLE trips ADD COLUMN docs_kind TEXT NOT NULL DEFAULT ''`);
  if (!cols.includes('docs_by')) db.exec(`ALTER TABLE trips ADD COLUMN docs_by TEXT NOT NULL DEFAULT ''`);
  db.prepare(`INSERT OR IGNORE INTO app_meta(key,value) VALUES('docs_return_since', ?)`).run(new Date().toISOString());
}

const days = (a, b) => (Date.parse(b) - Date.parse(a)) / 864e5;

export function docsNorm(db, nowMs = Date.now()) {
  const from = new Date(nowMs - 60 * 864e5).toISOString();
  const list = db.prepare(`SELECT COALESCE(unloaded_at, ends_at) u, docs_returned_at r FROM trips
    WHERE docs_returned_at IS NOT NULL AND docs_returned_at>=?`).all(from)
    .map(row => days(row.u, row.r)).filter(d => Number.isFinite(d) && d >= 0).sort((a, b) => a - b);
  return list.length >= 5 ? +list[Math.floor(list.length / 2)].toFixed(1) : null;
}

export function docsBoard(db, nowMs = Date.now()) {
  const since = db.prepare(`SELECT value FROM app_meta WHERE key='docs_return_since'`).get()?.value || new Date(nowMs).toISOString();
  const norm = docsNorm(db, nowMs);
  const now = new Date(nowMs).toISOString();
  const rows = db.prepare(`SELECT t.id, t.order_no, t.customer_name, t.status, COALESCE(t.unloaded_at, t.ends_at) unloaded,
      v.plate, v.driver_name, f.name from_name, z.name to_name
    FROM trips t JOIN vehicles v ON v.id=t.vehicle_id JOIN zones f ON f.id=t.from_zone_id JOIN zones z ON z.id=t.to_zone_id
    WHERE t.status IN ('unloaded','done','paid') AND t.docs_returned_at IS NULL
      AND COALESCE(t.unloaded_at, t.ends_at)>=? ORDER BY unloaded`).all(since)
    .map(row => {
      const waited = +days(row.unloaded, now).toFixed(1);
      return { ...row, waitedDays: waited, overdue: norm != null && waited > norm };
    });
  const returned = db.prepare(`SELECT COUNT(*) n FROM trips WHERE docs_returned_at>=?`).get(new Date(nowMs - 7 * 864e5).toISOString()).n;
  return { since, norm, items: rows, summary: { waiting: rows.length, overdue: rows.filter(row => row.overdue).length, returnedWeek: returned } };
}

export function markDocs(db, tripId, kind, name, at = new Date().toISOString()) {
  if (!DOC_KINDS[kind]) return { ok: false, error: 'Укажите, какие документы сданы' };
  const trip = db.prepare(`SELECT id, status, docs_returned_at FROM trips WHERE id=?`).get(tripId);
  if (!trip) return { ok: false, error: 'Рейс не найден' };
  if (!['unloaded', 'done', 'paid'].includes(trip.status)) return { ok: false, error: 'Документы отмечаются после выгрузки' };
  if (trip.docs_returned_at) return { ok: false, error: 'Документы уже отмечены' };
  db.prepare(`UPDATE trips SET docs_returned_at=?, docs_kind=?, docs_by=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(at, kind, name, tripId);
  return { ok: true };
}
