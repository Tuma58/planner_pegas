// ── Проект «Повышение эффективности» (запуск руководителя 09.10) ──
// Данные презентации за произвольный период + выпуски (пятница 08:00 —
// неделя, 23:59 последнего дня — месяц) с планом недели и сверкой
// «обещано → сделано». Деньги — только канон (money.mjs), парк —
// parkReportData (КТГ/КВЛ/КИП), ничего не считается своей формулой.

import { randomUUID } from 'node:crypto';
import { DONE_STATUSES, calcSettings, tripNet } from './money.mjs';
import { effectiveArrival, effectiveFinish } from './crew-fund.mjs';

export function effPeriodData(db, from, to, parkFn) {
  const calc = calcSettings(db);
  const trips = db.prepare(`SELECT status, cash, customer_name, revenue_vat, unloaded_at,
      ends_at, COALESCE(actual_distance_km, distance_km) km
    FROM trips WHERE status<>'rejected'`).all();
  let rev = 0;
  let n = 0;
  let km = 0;
  const byDow = Array(7).fill(0);
  const seenDays = new Set();
  const clientAgg = new Map();
  for (const t of trips) {
    if (!DONE_STATUSES.has(t.status)) continue;
    const d = String(t.unloaded_at || t.ends_at).slice(0, 10);
    if (d < from || d >= to) continue;
    const net = tripNet(t, calc);
    rev += net; n += 1; km += Number(t.km || 0);
    byDow[new Date(d + 'T00:00:00Z').getUTCDay()] += net;
    seenDays.add(d);
    const row = clientAgg.get(t.customer_name) || { name: t.customer_name, rev: 0, n: 0 };
    row.rev += net; row.n += 1;
    clientAgg.set(t.customer_name, row);
  }
  const dayCount = Array(7).fill(0);
  for (const d of seenDays) dayCount[new Date(d + 'T00:00:00Z').getUTCDay()] += 1;
  const wkDays = dayCount[1] + dayCount[2] + dayCount[3] + dayCount[4] + dayCount[5];
  const weDays = dayCount[0] + dayCount[6];
  const fleet = db.prepare(`SELECT COUNT(*) c FROM vehicles WHERE status='work'`).get().c;
  const days = Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 864e5));
  const downtime = {};
  for (const row of db.prepare(`SELECT kind,
      SUM(julianday(MIN(ends_at, :b)) - julianday(MAX(starts_at, :a))) d
    FROM vehicle_dispositions WHERE starts_at < :b AND ends_at > :a
    GROUP BY kind`).all({ a: from, b: to })) {
    downtime[row.kind] = Math.round(row.d || 0);
  }
  const park = parkFn ? parkFn(from, to).total : null;
  return {
    from, to, days, fleet,
    rev: Math.round(rev), trips: n, km: Math.round(km),
    avgCheck: n ? Math.round(rev / n) : 0,
    rubKm: km ? Math.round(rev / km) : 0,
    revPerVd: Math.round(rev / (fleet * days)),
    weekdayAvg: wkDays ? Math.round((byDow[1] + byDow[2] + byDow[3] + byDow[4] + byDow[5]) / wkDays) : 0,
    weekendAvg: weDays ? Math.round((byDow[0] + byDow[6]) / weDays) : 0,
    downtime,
    ktg: park?.ktg ?? null, kvl: park?.kvl ?? null, kip: park?.kip ?? null, koef: park?.koef ?? null,
    restDayAvg: park?.restH != null ? +(park.restH / 24 / days).toFixed(1) : null,
    clients: [...clientAgg.values()].map(c => ({ ...c, rev: Math.round(c.rev) }))
      .sort((a, b) => b.rev - a.rev).slice(0, 8)
  };
}

// Сервисные метрики периода (телефония/дисциплина) — живут с октября.
export function effServiceData(db, from, to) {
  const inb = db.prepare(`SELECT COUNT(*) n, SUM(target_user_id IS NOT NULL) a
    FROM call_events WHERE direction='in' AND status='' AND started_at>=? AND started_at<?`)
    .get(from, to);
  const missed = db.prepare(`SELECT COUNT(*) n, SUM(closed_at IS NOT NULL) c
    FROM driver_questions WHERE topic='missed_call' AND opened_at>=? AND opened_at<?`)
    .get(`${from} 00:00:00`, `${to} 00:00:00`);
  // Перезвоны: вход с номером → исходящий на тот же номер позже.
  const calls = db.prepare(`SELECT from_digits, started_at FROM call_events
    WHERE direction='in' AND status='' AND from_digits<>'' AND started_at>=? AND started_at<?`)
    .all(from, to);
  const outs = db.prepare(`SELECT to_phone, from_phone, started_at FROM call_events
    WHERE direction='out' AND started_at>=?`).all(from);
  const lags = [];
  for (const call of calls) {
    const hit = outs.find(o => o.started_at > call.started_at &&
      (String(o.to_phone).endsWith(call.from_digits) || String(o.from_phone).endsWith(call.from_digits)));
    if (hit) lags.push((Date.parse(hit.started_at) - Date.parse(call.started_at)) / 60000);
  }
  lags.sort((a, b) => a - b);
  return {
    inTotal: inb.n || 0, inAddressed: inb.a || 0,
    missedQuestions: missed.n || 0, missedClosed: missed.c || 0,
    callbackMedianMin: lags.length ? Math.round(lags[Math.floor(lags.length / 2)]) : null
  };
}

// ── Метрики потока канбан-доски (этап 3а, 11.10) ────────────────────
// Lead time колонок (медианы по закрытым рейсам, канон effectiveArrival/
// Finish), дисциплина отметок в реальный момент (ручной факт внесён в
// ≤30 мин от события), «выгружен позже убытия 12+ ч», участие смены и
// выученные ёмкости — база «до/после» для оценки эффекта доски.
export function effBoardData(db, from, to) {
  const median = list => { const l = list.filter(Number.isFinite).sort((a, b) => a - b);
    return l.length ? +(l[Math.floor(l.length / 2)]).toFixed(1) : null; };
  const hours = (a, b) => a && b
    ? (Date.parse(String(b).replace(' ', 'T')) - Date.parse(String(a).replace(' ', 'T'))) / 3.6e6 : null;
  const rows = db.prepare(`SELECT t.logist_confirmed_at, t.on_line_at, t.arrived_at, t.unloaded_at,
      (SELECT MIN(s.actual_departure) FROM trip_stops s
        WHERE s.trip_id=t.id AND s.kind='P' AND s.actual_departure IS NOT NULL) dep,
      (SELECT MAX(s.actual_arrival) FROM trip_stops s
        WHERE s.trip_id=t.id AND s.kind='D' AND s.actual_arrival IS NOT NULL) arr_d,
      (SELECT MAX(s.actual_departure) FROM trip_stops s
        WHERE s.trip_id=t.id AND s.kind='D' AND s.actual_departure IS NOT NULL) dep_d
    FROM trips t WHERE t.status IN ('unloaded','done','paid')
      AND t.unloaded_at >= ? AND t.unloaded_at < ?`).all(from, to);
  const lead = { prep: [], load: [], road: [], unload: [] };
  let lateClose12 = 0;
  for (const r of rows) {
    const arrived = effectiveArrival(r.dep, r.arrived_at, r.arr_d);
    const fin = effectiveFinish(arrived || r.dep, r.unloaded_at, r.dep_d) || r.unloaded_at;
    lead.prep.push(hours(r.logist_confirmed_at, r.on_line_at));
    lead.load.push(hours(r.on_line_at, r.dep));
    lead.road.push(hours(r.dep, arrived));
    lead.unload.push(hours(arrived, fin));
    if (r.dep_d && r.unloaded_at
      && Date.parse(String(r.unloaded_at).replace(' ', 'T')) -
         Date.parse(String(r.dep_d).replace(' ', 'T')) > 12 * 3.6e6) lateClose12 += 1;
  }
  // Дисциплина: ручной факт точки внесён в ≤30 мин от самого события
  // (updated_at против actual_*; GPS-автофакты не считаем — интересны люди).
  const facts = db.prepare(`SELECT actual_arrival, actual_departure, updated_at
    FROM trip_stops WHERE auto_source IS NULL AND updated_by IS NOT NULL
      AND updated_at >= ? AND updated_at < ?
      AND (actual_arrival IS NOT NULL OR actual_departure IS NOT NULL)`)
    .all(`${from} 00:00:00`, `${to} 00:00:00`);
  let realtime = 0;
  for (const f of facts) {
    const upd = Date.parse(String(f.updated_at).replace(' ', 'T') + 'Z');
    const evs = [f.actual_arrival, f.actual_departure]
      .filter(Boolean).map(v => Date.parse(String(v).replace(' ', 'T')));
    if (evs.some(ev => Math.abs(upd - ev) <= 30 * 60_000)) realtime += 1;
  }
  const marks = db.prepare(`SELECT COUNT(*) n, COUNT(DISTINCT done_by) people,
      COUNT(DISTINCT day) days FROM task_marks
    WHERE kind='dispatcher' AND day >= ? AND day < ? AND item_key NOT LIKE 'claim|%'`)
    .get(from, to);
  let capacity = null;
  try { capacity = JSON.parse(db.prepare(`SELECT value FROM app_meta
    WHERE key='dispatcher_capacity'`).get()?.value || 'null'); } catch { capacity = null; }
  return {
    trips: rows.length,
    leadPrepH: median(lead.prep), leadLoadH: median(lead.load),
    leadRoadH: median(lead.road), leadUnloadH: median(lead.unload),
    lateClose12,
    factsManual: facts.length,
    realtimeSharePct: facts.length ? Math.round(realtime / facts.length * 100) : null,
    ctrlMarksPerDay: marks.days ? Math.round(marks.n / marks.days) : 0,
    ctrlPeople: marks.people,
    shiftCapacity: capacity ? { fallback: capacity.fallback, caps: capacity.caps } : null
  };
}

export function effReport(db, { from, to, baseFrom, baseTo }, parkFn) {
  return {
    period: effPeriodData(db, from, to, parkFn),
    base: baseFrom ? effPeriodData(db, baseFrom, baseTo, parkFn) : null,
    service: effServiceData(db, from, to),
    board: effBoardData(db, from, to),
    boardBase: baseFrom ? effBoardData(db, baseFrom, baseTo) : null,
    initiatives: db.prepare(`SELECT id, title, area, target, result, status, effect_rub
      FROM project_initiatives WHERE status IN ('doing','done')
        AND updated_at >= ? ORDER BY status, updated_at DESC LIMIT 10`).all(`${from} 00:00:00`)
  };
}

// База сравнения по умолчанию: тот же отрезок прошлого месяца.
export function defaultBase(from, to) {
  const shift = iso => {
    const d = new Date(Date.parse(iso + 'T00:00:00Z'));
    d.setUTCMonth(d.getUTCMonth() - 1);
    return d.toISOString().slice(0, 10);
  };
  return { baseFrom: shift(from), baseTo: shift(to) };
}

// ── Выпуски ──
export function createIssue(db, { kind, from, to, baseFrom, baseTo, plan = [], userId = null }, parkFn) {
  const data = effReport(db, { from, to, baseFrom, baseTo }, parkFn);
  // Сверка: план предыдущего выпуска того же вида — «обещано → сделано».
  const prev = db.prepare(`SELECT plan_json, period_start, period_end FROM eff_issues
    WHERE kind=? AND period_start < ? ORDER BY period_start DESC LIMIT 1`).get(kind, from);
  const review = prev ? { periodStart: prev.period_start, periodEnd: prev.period_end,
    plan: JSON.parse(prev.plan_json || '[]') } : null;
  const id = randomUUID();
  db.prepare(`INSERT INTO eff_issues(id, kind, period_start, period_end, base_start, base_end,
      data_json, plan_json, review_json, created_by)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id, kind, from, to, baseFrom || null, baseTo || null,
    JSON.stringify(data), JSON.stringify(plan), JSON.stringify(review), userId);
  return { id, data, review };
}

export function listIssues(db, limit = 24) {
  return db.prepare(`SELECT id, kind, period_start, period_end, created_at FROM eff_issues
    ORDER BY period_start DESC, created_at DESC LIMIT ?`).all(limit);
}

export function getIssue(db, id) {
  const row = db.prepare(`SELECT * FROM eff_issues WHERE id=?`).get(id);
  if (!row) return null;
  return { id: row.id, kind: row.kind, periodStart: row.period_start, periodEnd: row.period_end,
    baseStart: row.base_start, baseEnd: row.base_end,
    data: JSON.parse(row.data_json), plan: JSON.parse(row.plan_json || '[]'),
    review: JSON.parse(row.review_json || 'null'), createdAt: row.created_at };
}

export function updateIssuePlan(db, id, plan) {
  const clean = (Array.isArray(plan) ? plan : []).slice(0, 12).map(item => ({
    title: String(item.title || '').slice(0, 200),
    metric: String(item.metric || '').slice(0, 200),
    owner: String(item.owner || '').slice(0, 80),
    done: Boolean(item.done),
    note: String(item.note || '').slice(0, 200)
  })).filter(item => item.title);
  const result = db.prepare(`UPDATE eff_issues SET plan_json=? WHERE id=?`)
    .run(JSON.stringify(clean), id);
  return result.changes > 0;
}
