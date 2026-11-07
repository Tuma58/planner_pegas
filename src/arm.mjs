// АРМ — рабочее место сотрудника (проект «Слияние», план 08-arm.md,
// утверждён руководителем 07.11.2026; этап Э1 — каркас и пилот на четырёх
// должностях: логист-диспетчер, диспетчер-контролёр, диспетчер учёта,
// механик).
//
// Каркас один для всех: шапка + четыре зоны в одном порядке — Анализ,
// План, Выполнение, Задачи. Различается только наполнение: реестр
// ARM_ROLES (набор роли → ключи виджетов по зонам). Виджеты — тонкие
// обёртки над уже работающими функциями планера (myShiftStats,
// nextAssignedShare, fieldLive, docsBoard, attendanceSummary,
// toStatusAll…): своих формул нет. Пороги — из Настроек или выучены
// (концепция живых нормативов); где нормы нет — показатель «справочно».
//
// Виджет: { kind: 'metric' | 'row' | 'task', label, value?, unit?, norm?,
//   tone?: 'pos'|'warn'|'neg'|'', note?, screen?, source }.

import { attendanceSummary, currentShift, myShiftStats, nextAssignedShare } from './planner-service.mjs';
import { fieldLive } from './field.mjs';
import { docsBoard } from './trip-docs.mjs';
import { toStatusAll } from './vehicle-card.mjs';

const DAY = 86_400_000;
const MSK = 3 * 3_600_000;
const mskDay = (ms, add = 0) => new Date(ms + MSK + add * DAY).toISOString().slice(0, 10);
const dayStartIso = day => new Date(Date.parse(`${day}T00:00:00Z`) - MSK).toISOString();
const hoursSince = (iso, nowMs) => iso ? Math.max(0, Math.round((nowMs - Date.parse(String(iso).replace(' ', 'T'))) / 3_600_000)) : null;
const safe = fn => { try { return fn(); } catch { return null; } };
const toneVsNorm = (value, norm, higherIsBetter = true) => value == null || norm == null ? ''
  : (higherIsBetter ? value >= norm : value <= norm) ? 'pos' : 'warn';

// ── Виджеты (ключ → функция ctx → виджет или массив виджетов) ──
const W = {
  // Анализ
  my_shift: ({ db, user, nowMs }) => {
    const s = safe(() => myShiftStats(db, user, nowMs));
    if (!s) return null;
    // Нормы к этому часу нет (смена только началась, базы нет) —
    // эффективность не выдумываем.
    if (!s.normToNow) {
      return { kind: 'metric', label: 'Операций за смену', value: s.ops, unit: '', tone: '',
        note: 'норма смены ещё не набрана — эффективность не считается', source: 'myShiftStats (журнал операций)' };
    }
    return [
      { kind: 'metric', label: 'Операций за смену', value: s.ops, norm: s.normToNow, unit: '',
        tone: toneVsNorm(s.ops, s.normToNow), note: `норма к этому часу ${s.normToNow} · в среднем ${s.avgShift} за смену`,
        source: 'myShiftStats (журнал операций)' },
      { kind: 'metric', label: 'Эффективность смены', value: s.effPct, unit: '%', norm: 100,
        tone: toneVsNorm(s.effPct, 100), note: `доля в смене ${s.sharePct}%`, source: 'myShiftStats' }
    ];
  },
  next_share: ({ db, nowMs, settings }) => {
    const to = new Date(nowMs).toISOString();
    const share = safe(() => nextAssignedShare(db, new Date(nowMs - 7 * DAY).toISOString(), to));
    if (!share) return null;
    const target = Number(settings.calculation?.nextAssignTargetPct ?? 85);
    return { kind: 'metric', label: 'Следующий рейс до выгрузки, 7 дн', value: share.pct, unit: '%', norm: target,
      tone: toneVsNorm(share.pct, target), note: share.total ? `${share.before} из ${share.total} · цель ${target}%` : 'выгрузок не было',
      source: 'nextAssignedShare · цель — Настройки' };
  },
  late_unload: ({ db, nowMs }) => {
    const from = new Date(nowMs - 7 * DAY).toISOString();
    const row = db.prepare(`SELECT COUNT(*) n, SUM(CASE WHEN julianday(unloaded_at) - julianday(ends_at) > 1.0/24 THEN 1 ELSE 0 END) late
      FROM trips WHERE unloaded_at IS NOT NULL AND unloaded_at>=? AND status<>'rejected'`).get(from);
    const pct = row.n ? Math.round((row.late || 0) / row.n * 100) : null;
    return { kind: 'metric', label: 'Выгрузка позже плана > 1 ч, 7 дн', value: pct, unit: '%',
      note: row.n ? `${row.late || 0} из ${row.n} выгрузок` : 'выгрузок не было', tone: '', source: 'trips: unloaded_at против ends_at (справочно)' };
  },
  docs_norm: ({ db, nowMs }) => {
    const board = safe(() => docsBoard(db, nowMs));
    if (!board) return null;
    return { kind: 'metric', label: 'Документы: норматив сдачи', value: board.norm, unit: 'сут',
      note: board.norm == null ? 'копится (нужно 5 сданных)' : `сдано за 7 дней ${board.summary.returnedWeek}`,
      tone: board.summary.overdue ? 'warn' : 'pos', source: 'docsBoard (медиана 60 дн)' };
  },
  attendance_yesterday: ({ db, nowMs }) => {
    const a = safe(() => attendanceSummary(db, mskDay(nowMs, -1)));
    if (!a) return null;
    return { kind: 'metric', label: 'Явка вчера', value: a.present, unit: '',
      note: `невыход ${a.absent}${a.unmarked ? ` · не отмечено ${a.unmarked}` : ''}`, tone: a.unmarked ? 'warn' : 'pos',
      source: 'attendanceSummary (табель)' };
  },
  repair_on_time: ({ db, nowMs }) => {
    const from = new Date(nowMs - 14 * DAY).toISOString();
    const row = db.prepare(`SELECT COUNT(*) n, SUM(CASE WHEN planned_out IS NULL OR released_at<=planned_out THEN 1 ELSE 0 END) ok
      FROM repair_orders WHERE status='released' AND released_at>=?`).get(from);
    const pct = row.n ? Math.round((row.ok || 0) / row.n * 100) : null;
    return { kind: 'metric', label: 'Выпуск из ремонта в срок, 14 дн', value: pct, unit: '%',
      note: row.n ? `${row.ok || 0} из ${row.n} нарядов` : 'выпусков не было', tone: '',
      source: 'repair_orders: released_at против planned_out' };
  },
  jobs_done: ({ db, nowMs }) => {
    const from = new Date(nowMs - 7 * DAY).toISOString();
    const row = db.prepare(`SELECT COUNT(*) n FROM repair_jobs j JOIN repair_orders o ON o.id=j.order_id
      WHERE j.status='done' AND COALESCE(o.released_at, o.updated_at)>=?`).get(from);
    return { kind: 'metric', label: 'Работ выполнено, 7 дн', value: row.n, unit: '', tone: '', source: 'repair_jobs' };
  },

  // План
  log_plan: ({ db, nowMs }) => {
    const now = new Date(nowMs).toISOString();
    const until = new Date(nowMs + 2 * DAY).toISOString();
    const noNext = db.prepare(`SELECT COUNT(*) n FROM trips t WHERE t.status IN ('plan','run') AND t.ends_at>=? AND t.ends_at<?
      AND NOT EXISTS (SELECT 1 FROM trips x WHERE x.vehicle_id=t.vehicle_id AND x.status<>'rejected' AND x.starts_at>t.starts_at)`).get(now, until).n;
    const tomorrow = mskDay(nowMs, 1);
    const orders = db.prepare(`SELECT COUNT(*) n FROM orders WHERE deleted_at IS NULL AND trip_id IS NULL
      AND status NOT IN ('rejected','cancelled') AND substr(window_from,1,10)<=?`).get(tomorrow).n;
    return [
      { kind: 'row', label: 'Выгрузятся за 2 суток без следующего рейса', value: noNext, tone: noNext ? 'warn' : 'pos', screen: 'logist', source: 'trips' },
      { kind: 'row', label: 'Заявки по завтра включительно без ТС', value: orders, tone: orders ? 'warn' : 'pos', screen: 'logist', source: 'orders' }
    ];
  },
  ctrl_plan: ({ db, nowMs }) => {
    const today = mskDay(nowMs);
    const from = dayStartIso(today);
    const to = dayStartIso(mskDay(nowMs, 1));
    const run = db.prepare(`SELECT COUNT(*) n FROM trips WHERE status='run'`).get().n;
    const unloadToday = db.prepare(`SELECT COUNT(*) n FROM trips WHERE status='run' AND ends_at>=? AND ends_at<?`).get(from, to).n;
    const stops = db.prepare(`SELECT COUNT(*) n FROM trip_stops s JOIN trips t ON t.id=s.trip_id
      WHERE t.status='run' AND s.actual_arrival IS NULL AND s.planned_arrival>=? AND s.planned_arrival<?`).get(from, to).n;
    return [
      { kind: 'row', label: 'Рейсов в пути', value: run, screen: 'dispatcher', source: 'trips' },
      { kind: 'row', label: 'Выгрузки сегодня по плану', value: unloadToday, screen: 'dispatcher', source: 'trips' },
      { kind: 'row', label: 'Точки сегодня без отметки прибытия', value: stops, screen: 'dispatcher', source: 'trip_stops' }
    ];
  },
  drv_plan: ({ db, nowMs }) => {
    const tomorrow = mskDay(nowMs, 1);
    const shifts = db.prepare(`SELECT COUNT(*) n FROM vehicle_dispositions WHERE kind='shift' AND starts_at>=? AND starts_at<?`)
      .get(dayStartIso(tomorrow), dayStartIso(mskDay(nowMs, 2))).n;
    const noDriverTomorrow = db.prepare(`SELECT COUNT(*) n FROM vehicle_dispositions WHERE kind='no_driver' AND starts_at<? AND ends_at>?`)
      .get(dayStartIso(mskDay(nowMs, 2)), dayStartIso(tomorrow)).n;
    return [
      { kind: 'row', label: 'Пересменки завтра', value: shifts, screen: 'resource', source: 'vehicle_dispositions' },
      { kind: 'row', label: 'Машин без водителя на завтра', value: noDriverTomorrow, tone: noDriverTomorrow ? 'warn' : 'pos', screen: 'resource', source: 'vehicle_dispositions' }
    ];
  },
  toir_plan: ({ db, nowMs }) => {
    const queued = db.prepare(`SELECT COUNT(*) n FROM repair_orders WHERE status='queued'`).get().n;
    const to = safe(() => toStatusAll(db, { nowMs })) || [];
    const due = to.filter(row => ['soon', 'overdue'].includes(row.status) || ['soon', 'overdue'].includes(row.hou?.status)).length;
    return [
      { kind: 'row', label: 'Очередь нарядов', value: queued, screen: 'remzona', source: 'repair_orders' },
      { kind: 'row', label: 'ТО скоро или просрочено', value: due, tone: due ? 'warn' : 'pos', screen: 'toboard', source: 'toStatusAll (нормы паспортов ТС)' }
    ];
  },

  // Выполнение
  log_queues_assign: ({ db }) => queuesOf(db, 'log', ['orders', 'idle']),
  log_queues_ctrl: ({ db }) => queuesOf(db, 'log', ['late']),
  my_holds: ({ db, user, nowMs }) => {
    const n = db.prepare(`SELECT COUNT(*) n FROM vehicle_holds WHERE held_by=? AND until>?`).get(user.id, new Date(nowMs).toISOString()).n;
    return { kind: 'row', label: 'Мои брони машин', value: n, screen: 'logist', source: 'vehicle_holds' };
  },
  cash_collect: ({ db }) => {
    const n = db.prepare(`SELECT COUNT(*) n FROM trips WHERE cash>0 AND status IN ('run','unloaded')`).get().n;
    return { kind: 'row', label: 'Рейсы с наличными к сбору', value: n, screen: 'dispatcher', source: 'trips.cash' };
  },
  docs_waiting: ({ db, nowMs }) => {
    const board = safe(() => docsBoard(db, nowMs));
    if (!board) return null;
    return { kind: 'row', label: 'Документы ждут сдачи', value: board.summary.waiting,
      note: board.summary.overdue ? `дольше норматива ${board.summary.overdue}` : '', tone: board.summary.overdue ? 'warn' : '',
      screen: 'docs', source: 'docsBoard' };
  },
  attendance_today: ({ db, nowMs }) => {
    const a = safe(() => attendanceSummary(db, mskDay(nowMs)));
    if (!a) return null;
    return { kind: 'row', label: 'Явка сегодня не отмечена', value: a.unmarked, tone: a.unmarked ? 'warn' : 'pos', screen: 'resource', source: 'attendanceSummary' };
  },
  drv_queues: ({ db }) => queuesOf(db, 'drv', ['no_driver']),
  toir_queues: ({ db, nowMs }) => {
    const now = new Date(nowMs).toISOString();
    const row = db.prepare(`SELECT SUM(status='in_progress') work, SUM(status='ready') ready,
      SUM(CASE WHEN status IN ('queued','in_progress','ready') AND planned_out IS NOT NULL AND planned_out<? THEN 1 ELSE 0 END) late
      FROM repair_orders`).get(now);
    return [
      { kind: 'row', label: 'В работе', value: row.work || 0, screen: 'remzona', source: 'repair_orders' },
      { kind: 'row', label: 'Готовы к выдаче', value: row.ready || 0, tone: row.ready ? 'warn' : '', screen: 'remzona', source: 'repair_orders' },
      { kind: 'row', label: 'Просрочен выпуск', value: row.late || 0, tone: row.late ? 'neg' : 'pos', screen: 'remzona', source: 'repair_orders' }
    ];
  },

  // Задачи
  release_requests: ({ db, nowMs }) => db.prepare(`SELECT r.id, r.need_by, r.note, r.requested_by_name, r.created_at, v.plate
      FROM remzona_release_requests r JOIN vehicles v ON v.id=r.vehicle_id WHERE r.status='open' ORDER BY r.created_at`).all()
    .map(row => ({ kind: 'task', label: `Запрос выпуска ${row.plate}${row.note ? `: ${row.note}` : ''}`,
      tag: `от ${row.requested_by_name || 'логиста'} · ${hoursSince(row.created_at, nowMs)} ч`, tone: 'warn', screen: 'remzona',
      source: 'remzona_release_requests' })),
  joint_cases: ({ db, nowMs }, joint, screen) => {
    const all = db.prepare(`SELECT plate, opened_at, signaled_at FROM joint_signals WHERE joint_key=? AND closed_at IS NULL
      ORDER BY signaled_at IS NULL, opened_at`).all(joint);
    const rows = all.slice(0, 5);
    const more = all.length > rows.length ? [{ kind: 'task', label: `…и ещё ${all.length - rows.length} по стыку «${JOINT_TITLE[joint]}»`,
      tag: 'весь список — в рабочем экране', tone: '', screen, source: 'joint_signals' }] : [];
    return [...rows.map(row => ({ kind: 'task', label: `${row.signaled_at ? '⚑ Сигнал' : 'Стык'}: ${row.plate}`,
      tag: `${JOINT_TITLE[joint]} · ${hoursSince(row.opened_at, nowMs)} ч`, tone: row.signaled_at ? 'neg' : 'warn', screen,
      source: 'joint_signals' })), ...more];
  },
  my_helpdesk: ({ db, user }) => db.prepare(`SELECT problem, status FROM helpdesk_tickets
      WHERE author_id=? AND status IN ('new','review','work') ORDER BY created_at DESC LIMIT 5`).all(user.id)
    .map(row => ({ kind: 'task', label: row.problem.slice(0, 120), tag: `HELP DESK · ${HD_STATUS[row.status] || row.status}`,
      tone: '', source: 'helpdesk_tickets' }))
};

const JOINT_TITLE = { drv_log: 'машина без задания', toir_drv: 'после ремонта без водителя', log_toir: 'ТО без заезда' };
const HD_STATUS = { new: 'новая', review: 'на рассмотрении', work: 'в работе' };

function queuesOf(db, dept, keys) {
  return (safe(() => fieldLive(db, dept).queues) || []).filter(queue => keys.includes(queue.key))
    .map(queue => ({ kind: 'row', label: queue.label, value: queue.count, note: queue.note || '', tone: queue.count ? 'warn' : 'pos',
      screen: queue.screen, source: 'fieldLive (очереди поля)' }));
}

// ── Реестр должностей (набор роли → виджеты по зонам) ──
// Э1 — пилот; остальные наборы добавляются строкой (Э3).
export const ARM_ROLES = {
  log_assign: { analysis: ['my_shift', 'next_share'], plan: ['log_plan'], exec: ['log_queues_assign', 'my_holds'],
    tasks: [['joint_cases', 'drv_log', 'logist'], 'my_helpdesk'] },
  log_ctrl: { analysis: ['my_shift', 'late_unload'], plan: ['ctrl_plan'], exec: ['log_queues_ctrl', 'cash_collect'],
    tasks: ['my_helpdesk'] },
  drv_acc: { analysis: ['docs_norm', 'attendance_yesterday'], plan: ['drv_plan'], exec: ['docs_waiting', 'attendance_today', 'drv_queues'],
    tasks: [['joint_cases', 'toir_drv', 'resource'], 'my_helpdesk'] },
  toir_mech: { analysis: ['repair_on_time', 'jobs_done'], plan: ['toir_plan'], exec: ['toir_queues'],
    tasks: ['release_requests', ['joint_cases', 'log_toir', 'toboard'], 'my_helpdesk'] }
};
export const ARM_ZONES = [['analysis', 'Анализ'], ['plan', 'План'], ['exec', 'Выполнение'], ['tasks', 'Задачи']];

// Набор пользователя, у которого есть АРМ (первый из реестра).
export function armRoleOf(sets = []) {
  return sets.find(id => ARM_ROLES[id]) || null;
}

function personOf(db, user, nowMs) {
  const position = user.position_id ? db.prepare(`SELECT p.title, p.dept_key, d.name dept_name FROM org_positions p
    LEFT JOIN org_depts d ON d.key=p.dept_key WHERE p.id=?`).get(user.position_id) : null;
  const shift = currentShift(nowMs);
  const deptTask = position?.dept_key ? safe(() => db.prepare(`SELECT title FROM org_goals WHERE kind='task' AND dept_key=?
    AND archived_at IS NULL ORDER BY sort LIMIT 1`).get(position.dept_key)?.title) : null;
  return { name: user.full_name || user.username, position: position?.title || '', dept: position?.dept_key || '',
    deptName: position?.dept_name || '', shift: shift.kind === 'night' ? 'ночная смена 20:00–08:00' : 'дневная смена 08:00–20:00',
    deptTask: deptTask || '' };
}

// Данные АРМ: шапка + четыре зоны. roleId — набор из реестра.
export function armData(db, user, roleId, { nowMs = Date.now(), settings = {} } = {}) {
  const spec = ARM_ROLES[roleId];
  if (!spec) return null;
  const ctx = { db, user, nowMs, settings };
  const zones = Object.fromEntries(ARM_ZONES.map(([zone]) => [zone, (spec[zone] || []).flatMap(entry => {
    const [key, ...args] = Array.isArray(entry) ? entry : [entry];
    const out = safe(() => W[key](ctx, ...args));
    return out == null ? [] : Array.isArray(out) ? out : [out];
  })]));
  return { role: roleId, person: personOf(db, user, nowMs), zones, zoneTitles: Object.fromEntries(ARM_ZONES),
    assignedNote: 'Задачи от руководителя — следующий этап (Э2)' };
}

// GET /api/arm — АРМ текущего пользователя по его набору ролей.
export function armApi(ctx) {
  const { db, request, response, pathname, user, access, json, errorJson, settingsObject } = ctx;
  if (pathname !== '/api/arm') return false;
  if (request.method !== 'GET') { errorJson(response, 405, 'Только чтение'); return true; }
  if (!user) { errorJson(response, 401, 'Требуется вход'); return true; }
  const roleId = access && !access.legacy ? armRoleOf(access.sets || []) : null;
  if (!roleId) { json(response, 200, { pilot: false }); return true; }
  json(response, 200, { pilot: true, ...armData(db, user, roleId, { settings: settingsObject(db) }) });
  return true;
}
