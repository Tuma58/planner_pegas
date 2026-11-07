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
import { randomUUID } from 'node:crypto';
import { directionGoals } from '../public/assets/goals-core.js';
import { signalKpi } from './signals.mjs';
import { safetyBoard } from './safety.mjs';
import { releaseBoard } from './release.mjs';
import { gateOnsite } from './gate.mjs';
import { partsStock } from './parts.mjs';
import { driverTurnover } from './turnover.mjs';
import { leadStats } from './crm.mjs';

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

// ── Э3: виджеты остальных должностей (07.11) ──
// Коэффициенты — канон периода parkReportData (тот же, что у «Моего
// поля»), сервер даёт его лениво через ctx.park(); цели — Настройки.
const COEF = { ktg: ['КТГ', 'ktg', 'ktg'], kvl: ['КВЛ', 'kvl', 'kvl'], kip: ['КИП', 'kip', 'kip'], use: ['КЭИП', 'koef', 'use'] };
const CONTROL = { log: 'log_toir', drv: 'drv_log', toir: 'toir_drv' };
Object.assign(W, {
  coef: ({ park, settings }, key) => {
    const total = park?.()?.total;
    if (!total) return null;
    const [label, field, goal] = COEF[key];
    const target = directionGoals(settings.calculation)[goal];
    return { kind: 'metric', label: `${label}, месяц`, value: total[field], unit: '%', norm: target,
      tone: toneVsNorm(total[field], target), note: `цель ${target}%`, source: 'parkReportData · цель — Настройки' };
  },
  revenue: ({ park, money }) => {
    if (money !== 'full') return null;
    const total = park?.()?.total;
    if (!total) return null;
    return { kind: 'metric', label: 'Выручка месяца, млн', value: Math.round(total.rev / 1e5) / 10, unit: '',
      note: `${total.trips} выгрузок · план — «Цели и задачи»`, tone: '', source: 'parkReportData (без НДС)' };
  },
  vigilance: ({ db, nowMs, settings }, dept) => {
    const joint = CONTROL[dept];
    const from = new Date(nowMs - 30 * DAY).toISOString();
    const k = safe(() => signalKpi(db, joint, from, new Date(nowMs).toISOString(), directionGoals(settings.calculation).signalTargetH));
    if (!k) return null;
    return { kind: 'metric', label: 'Сигналы стыка вовремя, 30 дн', value: k.onTimePct, unit: '%',
      note: k.cases ? `${k.cases} случаев · цель ≤ ${k.targetH} ч` : 'случаев не было', tone: '', source: `signalKpi (${JOINT_TITLE[joint]})` };
  },
  dept_queues: ({ db }, dept) => queuesOf(db, dept, null),
  dir_plan: ctx => [...(W.log_plan(ctx) || []).slice(1), ...(W.drv_plan(ctx) || []).slice(1), ...(W.toir_plan(ctx) || []).slice(1)],
  turnover_month: ({ db, nowMs }) => {
    const t = safe(() => driverTurnover(db, { from: `${mskDay(nowMs).slice(0, 7)}-01`, to: mskDay(nowMs), sync: false }));
    if (!t) return null;
    return { kind: 'metric', label: 'Текучесть водителей, месяц', value: t.turnoverPct, unit: '%', norm: t.targetPct,
      tone: t.targetPct == null || t.turnoverPct == null ? '' : t.turnoverPct <= t.targetPct ? 'pos' : 'warn',
      note: `уволено ${t.fired} · средняя численность ${Math.round(t.headcountAvg || 0)}`, source: 'driverTurnover · цель — Настройки' };
  },
  drv_shift_queue: ({ db }) => queuesOf(db, 'drv', ['no_driver', 'shift']),
  leads: ({ db, nowMs }) => {
    const stats = safe(() => leadStats(db.prepare('SELECT * FROM crm_leads').all(), new Date(nowMs).toISOString()));
    if (!stats) return null;
    return { kind: 'metric', label: 'Воронка: в работе', value: stats.open, unit: '',
      note: stats.closed ? `конверсия ${Math.round((stats.winRate || 0) * 100)}% · шаг просрочен ${stats.overdueSteps}` : `шаг просрочен ${stats.overdueSteps}`,
      tone: stats.overdueSteps ? 'warn' : '', source: 'CRM · crm_leads' };
  },
  lead_steps: ({ db, nowMs }) => {
    const today = mskDay(nowMs);
    const n = db.prepare(`SELECT COUNT(*) n FROM crm_leads WHERE stage NOT IN ('won','lost') AND next_at IS NOT NULL AND substr(next_at,1,10)<=?`).get(today).n;
    return { kind: 'row', label: 'Шаги по лидам на сегодня и просроченные', value: n, tone: n ? 'warn' : 'pos', screen: 'crm', source: 'crm_leads' };
  },
  claims_new: ({ db }) => {
    const n = safe(() => db.prepare(`SELECT COUNT(*) n FROM demurrage_claims WHERE status='new'`).get().n);
    return n == null ? null : { kind: 'row', label: 'Претензии за простой ждут выставления', value: n, tone: n ? 'warn' : 'pos', screen: 'sales', source: 'demurrage_claims' };
  },
  orders_queue: ({ db }) => queuesOf(db, 'log', ['orders']),
  release_today: ({ db, nowMs }) => {
    const b = safe(() => releaseBoard(db, nowMs));
    if (!b) return null;
    return [
      { kind: 'row', label: 'Выход сегодня и завтра', value: b.summary.total, screen: 'release', source: 'releaseBoard' },
      { kind: 'row', label: 'Ждут техконтроля', value: b.summary.wait, tone: b.summary.wait ? 'warn' : 'pos', screen: 'release', source: 'releaseBoard' },
      { kind: 'row', label: 'Риск не выйти вовремя', value: (b.summary.risk || 0) + (b.summary.late || 0), tone: (b.summary.risk || b.summary.late) ? 'neg' : 'pos', screen: 'release', source: 'releaseBoard' }
    ];
  },
  release_stats: ({ db, nowMs }) => {
    const from = new Date(nowMs - 7 * DAY).toISOString();
    const row = safe(() => db.prepare(`SELECT SUM(result='ok') pass, SUM(result='fail') fail FROM release_checks WHERE checked_at>=?`).get(from)) || {};
    return [
      { kind: 'metric', label: 'Техконтроль пройден, 7 дн', value: row.pass || 0, unit: '', tone: '', source: 'release_checks' },
      { kind: 'metric', label: '«В ремонт» с выпуска, 7 дн', value: row.fail || 0, unit: '', tone: '', source: 'release_checks' }
    ];
  },
  parts: ({ db, settings, money }) => {
    const st = safe(() => partsStock(db, { settings }));
    if (!st) return null;
    const items = st.items || [];
    const below = items.filter(item => item.below).length;
    const value = items.reduce((sum, item) => sum + (item.stockValue || 0), 0);
    return [
      { kind: 'metric', label: 'Позиций ниже минимума', value: below, unit: '', tone: below ? 'warn' : 'pos', note: `всего позиций ${items.length}`, source: 'partsStock' },
      ...(money !== 'none' ? [{ kind: 'metric', label: 'Запас на складе, тыс ₽', value: Math.round(value / 100) / 10, unit: '', tone: '', source: 'partsStock (средняя цена)' }] : [])
    ];
  },
  parts_plan: ({ db }) => {
    const n = safe(() => db.prepare(`SELECT COUNT(*) n FROM parts_requests WHERE status='open'`).get().n);
    return n == null ? null : { kind: 'row', label: 'Заявки поставщикам в пути', value: n, screen: 'parts', source: 'parts_requests' };
  },
  parts_buy: ({ db, settings }) => {
    const st = safe(() => partsStock(db, { settings }));
    if (!st) return null;
    const n = (st.items || []).filter(item => item.toBuy > 0).length;
    return { kind: 'row', label: 'К закупке, позиций', value: n, tone: n ? 'warn' : 'pos', screen: 'parts', source: 'partsStock' };
  },
  safety: ({ db, nowMs, settings }) => {
    const b = safe(() => safetyBoard(db, { from: `${mskDay(nowMs).slice(0, 7)}-01`, to: mskDay(nowMs), warnDays: directionGoals(settings.calculation).docsWarnDays, nowMs }));
    if (!b) return null;
    return {
      analysis: [
        { kind: 'metric', label: 'ДТП за месяц', value: b.summary.dtp, unit: '', tone: b.summary.dtp ? 'neg' : 'pos', source: 'safetyBoard' },
        { kind: 'metric', label: 'Нарушения ПДД и РТО', value: b.summary.pdd + b.summary.rto, unit: '', tone: '', note: `ПДД ${b.summary.pdd} · РТО ${b.summary.rto}`, source: 'safetyBoard' }],
      plan: [{ kind: 'row', label: 'Допуски и инструктажи истекают', value: b.summary.termsDue, tone: b.summary.termsDue ? 'warn' : 'pos', screen: 'safety', source: 'safetyBoard · порог — Настройки' }],
      exec: [
        { kind: 'row', label: 'Открытые расследования', value: b.summary.open, tone: b.summary.open ? 'warn' : 'pos', screen: 'safety', source: 'safetyBoard' },
        { kind: 'row', label: 'Водители без действующего допуска', value: b.withoutAdmission.length, tone: b.withoutAdmission.length ? 'neg' : 'pos', screen: 'safety', source: 'safetyBoard' }]
    };
  },
  safety_analysis: ctx => W.safety(ctx)?.analysis,
  safety_plan: ctx => W.safety(ctx)?.plan,
  safety_exec: ctx => W.safety(ctx)?.exec,
  gate: ({ db, nowMs, settings }) => {
    const onsite = safe(() => gateOnsite(db)) || [];
    const longH = directionGoals(settings.calculation).gateLongH;
    const long = onsite.filter(row => hoursSince(row.entry_at, nowMs) >= longH).length;
    return [
      { kind: 'row', label: 'На территории сейчас', value: onsite.length, screen: 'gate', source: 'gate_log' },
      { kind: 'row', label: `Стоят дольше ${longH} ч`, value: long, tone: long ? 'warn' : 'pos', screen: 'gate', source: 'gate_log · порог — Настройки' }
    ];
  },
  gate_day: ({ db, nowMs }) => {
    const from = dayStartIso(mskDay(nowMs));
    const row = db.prepare(`SELECT SUM(entry_at>=?) inn, SUM(exit_at>=?) outn FROM gate_log WHERE status<>'cancelled'`).get(from, from);
    return [
      { kind: 'metric', label: 'Въездов сегодня', value: row.inn || 0, unit: '', tone: '', source: 'gate_log' },
      { kind: 'metric', label: 'Выездов сегодня', value: row.outn || 0, unit: '', tone: '', source: 'gate_log' }
    ];
  },
  helpdesk_new: ({ db }) => {
    const n = db.prepare(`SELECT COUNT(*) n FROM helpdesk_tickets WHERE status IN ('new','review')`).get().n;
    return { kind: 'row', label: 'Заявки HELP DESK без решения', value: n, tone: n ? 'warn' : 'pos', source: 'helpdesk_tickets' };
  },
  paid_week: ({ db, nowMs }) => {
    const n = safe(() => db.prepare(`SELECT COUNT(*) n FROM trips WHERE paid_at>=?`).get(new Date(nowMs - 7 * DAY).toISOString()).n);
    return { kind: 'metric', label: 'Отмечено оплат, 7 дн', value: n, unit: '', tone: '', source: 'trips.paid_at' };
  },
  receivables_off: ({ settings }) => settings.calculation?.crmReceivablesOn === true
    ? { kind: 'row', label: 'Рейсы к оплате по сроку', value: null, note: 'см. экран', screen: 'payments', source: 'CRM' }
    : { kind: 'row', label: 'Учёт долгов клиентов выключен', value: null, note: 'включается в Настройках', screen: 'payments', source: 'Настройки' }
});

// Задачи смены по процессу (боковые панели экранов Диспетчер / Логист /
// Планирование, Э4): список живёт в рабочем экране — в АРМ счётчик
// отмеченных сегодня и переход туда (панели остаются там, где работа).
const PROCESS = { logist: ['Логист', 'logist'], dispatcher: ['Диспетчер', 'dispatcher'], sales: ['Планирование', 'sales'] };
W.process_marks = ({ db, nowMs }, kind) => {
  const day = mskDay(nowMs);
  const n = safe(() => db.prepare(`SELECT COUNT(*) n FROM task_marks WHERE kind=? AND day=?`).get(kind, day).n) ?? 0;
  return { kind: 'task', label: `Задачи смены по процессу — панель экрана «${PROCESS[kind][0]}»`, tag: `отмечено сегодня ${n}`,
    tone: '', screen: PROCESS[kind][1], source: 'task_marks' };
};

const JOINT_TITLE = { drv_log: 'машина без задания', toir_drv: 'после ремонта без водителя', log_toir: 'ТО без заезда' };
const HD_STATUS = { new: 'новая', review: 'на рассмотрении', work: 'в работе' };

function queuesOf(db, dept, keys) {
  return (safe(() => fieldLive(db, dept).queues) || []).filter(queue => !keys || keys.includes(queue.key))
    .map(queue => ({ kind: 'row', label: queue.label, value: queue.count, note: queue.note || '', tone: queue.count ? 'warn' : 'pos',
      screen: queue.screen, source: 'fieldLive (очереди поля)' }));
}

// ── Реестр должностей (набор роли → виджеты по зонам) ──
// Э1 — пилот; остальные наборы добавляются строкой (Э3).
export const ARM_ROLES = {
  log_assign: { analysis: ['my_shift', 'next_share'], plan: ['log_plan'], exec: ['log_queues_assign', 'my_holds'],
    tasks: [['process_marks', 'logist'], ['joint_cases', 'drv_log', 'logist'], 'my_helpdesk'] },
  log_ctrl: { analysis: ['my_shift', 'late_unload'], plan: ['ctrl_plan'], exec: ['log_queues_ctrl', 'cash_collect'],
    tasks: [['process_marks', 'dispatcher'], 'my_helpdesk'] },
  drv_acc: { analysis: ['docs_norm', 'attendance_yesterday'], plan: ['drv_plan'], exec: ['docs_waiting', 'attendance_today', 'drv_queues'],
    tasks: [['joint_cases', 'toir_drv', 'resource'], 'my_helpdesk'] },
  toir_mech: { analysis: ['repair_on_time', 'jobs_done'], plan: ['toir_plan'], exec: ['toir_queues'],
    tasks: ['release_requests', ['joint_cases', 'log_toir', 'toboard'], 'my_helpdesk'] },
  // Э3 (07.11): остальные должности по таблице плана.
  dir_head: { analysis: [['coef', 'ktg'], ['coef', 'kvl'], ['coef', 'kip'], ['coef', 'use'], 'revenue'], plan: ['dir_plan'],
    exec: [['dept_queues', 'log'], ['dept_queues', 'drv'], ['dept_queues', 'toir']],
    tasks: [['joint_cases', 'drv_log', 'field'], ['joint_cases', 'toir_drv', 'field'], ['joint_cases', 'log_toir', 'field'], 'my_helpdesk'] },
  // Руководители отделов (Э4, 07.11): показатели, стыки с сигналами,
  // очереди, задачи и деньги отдела — секции «Моего поля» внутри зон
  // (фронт берёт /api/field); здесь — то, чего в поле нет.
  log_head: { analysis: [], plan: ['log_plan'], exec: [], tasks: ['my_helpdesk'], field: 'log' },
  log_plan: { analysis: ['my_shift', 'leads'], plan: ['lead_steps', 'log_plan'], exec: ['orders_queue', 'claims_new'], tasks: [['process_marks', 'sales'], 'my_helpdesk'] },
  drv_head: { analysis: ['turnover_month'], plan: ['drv_plan', 'release_today'], exec: [], tasks: ['my_helpdesk'], field: 'drv' },
  drv_column: { analysis: ['attendance_yesterday', 'turnover_month'], plan: ['drv_plan'], exec: ['drv_shift_queue', 'attendance_today'],
    tasks: [['joint_cases', 'toir_drv', 'resource'], 'my_helpdesk'] },
  drv_tech: { analysis: ['release_stats'], plan: ['release_today'], exec: ['toir_queues'], tasks: ['my_helpdesk'] },
  toir_head: { analysis: ['repair_on_time'], plan: ['toir_plan', 'parts_plan'], exec: ['parts_buy'],
    tasks: ['release_requests', 'my_helpdesk'], field: 'toir' },
  toir_supply: { analysis: ['parts'], plan: ['parts_plan'], exec: ['parts_buy'], tasks: ['my_helpdesk'] },
  staff_bdd: { analysis: ['safety_analysis'], plan: ['safety_plan'], exec: ['safety_exec'], tasks: ['my_helpdesk'] },
  staff_aho: { analysis: ['gate_day'], plan: ['gate'], exec: ['helpdesk_new'], tasks: ['my_helpdesk'] },
  guard: { analysis: ['gate_day'], plan: [], exec: ['gate'], tasks: ['my_helpdesk'] },
  accountant: { analysis: ['paid_week', 'docs_norm'], plan: ['receivables_off'], exec: ['docs_waiting'], tasks: ['my_helpdesk'] }
};
ARM_ROLES.admin = ARM_ROLES.dir_head;
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

// ── Э2: задачи сотруднику (план 08-arm.md, решение руководителя 07.11) ──
// Ставит руководитель направления — любому; внутри отдела — любой
// сотрудник отдела любому коллеге своего отдела (руководитель — своим
// подчинённым, коллеги — друг другу). Между отделами задачи не ставятся —
// для этого стыки и «⚑ Сигнал». Статусы: новая → в работе → сделано /
// не сделано (с причиной); автор может снять задачу.
export const TASK_STATUS = { new: 'новая', work: 'в работе', done: 'сделано', failed: 'не сделано', cancelled: 'снята' };

export function migrateArm(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS arm_tasks (
    id TEXT PRIMARY KEY, from_user_id TEXT, from_name TEXT NOT NULL DEFAULT '',
    to_user_id TEXT NOT NULL, to_name TEXT NOT NULL DEFAULT '', dept_key TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', about TEXT NOT NULL DEFAULT '', due_at TEXT,
    status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','work','done','failed','cancelled')),
    result TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, closed_at TEXT,
    CHECK(status <> 'failed' OR length(trim(result)) > 0))`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_arm_tasks_to ON arm_tasks(to_user_id, status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_arm_tasks_from ON arm_tasks(from_user_id, status)`);
}

const deptOf = (db, user) => user?.position_id
  ? db.prepare('SELECT dept_key FROM org_positions WHERE id=?').get(user.position_id)?.dept_key || '' : '';
const isDirection = access => Boolean(access && (access.legacy ? false : access.scope?.all));
// Руководитель для «глазами сотрудника»: поле управления в наборе.
const isHead = access => Boolean(access && !access.legacy && (access.views || []).includes('field'));

// Можно ли поставить задачу: направление — любому; иначе — тот же отдел.
export function canAssign(db, from, fromAccess, to) {
  if (!from || !to || from.id === to.id || !to.active || to.deleted_at) return false;
  if (isDirection(fromAccess)) return true;
  const dept = deptOf(db, from);
  return Boolean(dept) && dept === deptOf(db, to);
}

// Можно ли смотреть АРМ сотрудника: сам; руководитель направления — всех;
// руководитель отдела — своего отдела.
export function canView(db, viewer, viewerAccess, target) {
  if (!viewer || !target) return false;
  if (viewer.id === target.id) return true;
  if (isDirection(viewerAccess)) return true;
  return isHead(viewerAccess) && Boolean(deptOf(db, viewer)) && deptOf(db, viewer) === deptOf(db, target);
}

// Кому я могу поставить задачу (и чьё место посмотреть).
export function peopleFor(db, user, access) {
  const rows = db.prepare(`SELECT u.id, u.full_name, u.position_id, u.active, u.deleted_at, p.title position, p.dept_key
    FROM users u LEFT JOIN org_positions p ON p.id=u.position_id
    WHERE u.active=1 AND u.deleted_at IS NULL ORDER BY p.dept_key, u.full_name`).all();
  return rows.filter(row => canAssign(db, user, access, row)).map(row => ({ id: row.id, name: row.full_name,
    position: row.position || '', dept: row.dept_key || '', canView: canView(db, user, access, row) }));
}

export function addTask(db, from, fromAccess, body, nowMs = Date.now()) {
  const to = body.toUserId ? db.prepare('SELECT * FROM users WHERE id=?').get(body.toUserId) : null;
  if (!to) return { status: 422, error: 'Укажите, кому задача' };
  if (!canAssign(db, from, fromAccess, to)) {
    return { status: 403, error: 'Задачу можно поставить коллеге своего отдела; между отделами — стыки и «⚑ Сигнал»' };
  }
  const title = String(body.title || '').trim().slice(0, 300);
  if (!title) return { status: 422, error: 'Опишите, что сделать' };
  const due = body.dueAt && Number.isFinite(Date.parse(body.dueAt)) ? new Date(Date.parse(body.dueAt)).toISOString() : null;
  if (!due) return { status: 422, error: 'Укажите срок' };
  if (Date.parse(due) < nowMs - 60_000) return { status: 422, error: 'Срок уже прошёл' };
  const id = randomUUID();
  db.prepare(`INSERT INTO arm_tasks(id,from_user_id,from_name,to_user_id,to_name,dept_key,title,body,about,due_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id, from.id, from.full_name || from.username || '', to.id, to.full_name || '',
    deptOf(db, to), title, String(body.body || '').trim().slice(0, 2000), String(body.about || '').trim().slice(0, 200), due);
  return { ok: true, id, to };
}

// Действие по задаче: take / done / fail — исполнитель; cancel — автор.
export function taskAction(db, user, id, action, result = '', nowMs = Date.now()) {
  const task = db.prepare('SELECT * FROM arm_tasks WHERE id=?').get(id);
  if (!task) return { status: 404, error: 'Задача не найдена' };
  const open = ['new', 'work'].includes(task.status);
  const now = new Date(nowMs).toISOString();
  const text = String(result || '').trim().slice(0, 2000);
  if (action === 'cancel') {
    if (task.from_user_id !== user.id) return { status: 403, error: 'Снять задачу может только тот, кто её поставил' };
    if (!open) return { status: 409, error: 'Задача уже закрыта' };
    db.prepare(`UPDATE arm_tasks SET status='cancelled', result=?, updated_at=?, closed_at=? WHERE id=?`).run(text, now, now, id);
    return { ok: true, task, notify: task.to_user_id };
  }
  if (task.to_user_id !== user.id) return { status: 403, error: 'Отмечает исполнитель' };
  if (!open) return { status: 409, error: 'Задача уже закрыта' };
  if (action === 'take') {
    db.prepare(`UPDATE arm_tasks SET status='work', updated_at=? WHERE id=?`).run(now, id);
    return { ok: true, task };
  }
  if (action === 'done') {
    db.prepare(`UPDATE arm_tasks SET status='done', result=?, updated_at=?, closed_at=? WHERE id=?`).run(text, now, now, id);
    return { ok: true, task, notify: task.from_user_id };
  }
  if (action === 'fail') {
    if (!text) return { status: 422, error: 'Укажите причину' };
    db.prepare(`UPDATE arm_tasks SET status='failed', result=?, updated_at=?, closed_at=? WHERE id=?`).run(text, now, now, id);
    return { ok: true, task, notify: task.from_user_id };
  }
  return { status: 422, error: 'Неизвестное действие' };
}

const dueLabel = (iso, nowMs) => {
  if (!iso) return '';
  const left = Date.parse(iso) - nowMs;
  const at = new Date(Date.parse(iso) + MSK).toISOString().slice(5, 16).replace('T', ' ').split(' ');
  const when = `${at[0].split('-').reverse().join('.')} ${at[1]}`;
  return left < 0 ? `просрочена · срок ${when}` : `срок ${when}`;
};

// Задачи в АРМ: мне (с действиями) и поставленные мной (открытые).
function tasksWidgets(db, user, nowMs, readOnly) {
  const mine = db.prepare(`SELECT * FROM arm_tasks WHERE to_user_id=? AND status IN ('new','work') ORDER BY due_at`).all(user.id)
    .map(task => {
      const overdue = task.due_at && Date.parse(task.due_at) < nowMs;
      return { kind: 'task', id: task.id, label: task.title, body: task.body, about: task.about,
        tag: `от ${task.from_name} · ${dueLabel(task.due_at, nowMs)}`, tone: overdue ? 'neg' : task.status === 'work' ? '' : 'warn',
        status: task.status, actions: readOnly ? [] : task.status === 'new' ? ['take', 'done', 'fail'] : ['done', 'fail'],
        source: 'arm_tasks · поставлена мне' };
    });
  const given = db.prepare(`SELECT * FROM arm_tasks WHERE from_user_id=? AND status IN ('new','work') ORDER BY due_at`).all(user.id)
    .map(task => ({ kind: 'task', id: task.id, label: `${task.to_name}: ${task.title}`, mineGiven: true,
      tag: `${TASK_STATUS[task.status]} · ${dueLabel(task.due_at, nowMs)}`,
      tone: task.due_at && Date.parse(task.due_at) < nowMs ? 'neg' : '', actions: readOnly ? [] : ['cancel'],
      source: 'arm_tasks · поставлена мной' }));
  return { mine, given };
}

// «Задачи в срок» за 30 дней — справочно (нормы нет; цель — в Э3, если
// руководитель её задаст).
W.tasks_on_time = ({ db, user, nowMs }) => {
  const from = new Date(nowMs - 30 * DAY).toISOString();
  const row = db.prepare(`SELECT COUNT(*) n, SUM(CASE WHEN status='done' AND (due_at IS NULL OR closed_at<=due_at) THEN 1 ELSE 0 END) ok
    FROM arm_tasks WHERE to_user_id=? AND status IN ('done','failed') AND closed_at>=?`).get(user.id, from);
  return { kind: 'metric', label: 'Задачи в срок, 30 дн', value: row.n ? Math.round((row.ok || 0) / row.n * 100) : null, unit: '%',
    note: row.n ? `${row.ok || 0} из ${row.n} закрытых` : 'закрытых задач ещё нет', tone: '', source: 'arm_tasks' };
};

// Данные АРМ: шапка + четыре зоны. roleId — набор из реестра; нет его —
// каркас тот же, зоны по должности пустые до Э3, задачи работают.
export function armData(db, user, roleId, { nowMs = Date.now(), settings = {}, readOnly = false, park = null, money = 'none' } = {}) {
  const spec = ARM_ROLES[roleId] || { analysis: [], plan: [], exec: [], tasks: ['my_helpdesk'] };
  let parkCache;
  const ctx = { db, user, nowMs, settings, money, park: () => (parkCache === undefined ? (parkCache = safe(() => park?.()) || null) : parkCache) };
  const zones = Object.fromEntries(ARM_ZONES.map(([zone]) => [zone, (spec[zone] || []).flatMap(entry => {
    const [key, ...args] = Array.isArray(entry) ? entry : [entry];
    const out = safe(() => W[key](ctx, ...args));
    return out == null ? [] : Array.isArray(out) ? out : [out];
  })]));
  const tasks = tasksWidgets(db, user, nowMs, readOnly);
  zones.tasks = [...tasks.mine, ...zones.tasks];
  zones.analysis = [...zones.analysis, W.tasks_on_time(ctx)];
  return { role: roleId, pilot: Boolean(ARM_ROLES[roleId]), fieldDept: spec.field || null, person: personOf(db, user, nowMs), zones,
    zoneTitles: Object.fromEntries(ARM_ZONES), given: tasks.given, readOnly,
    pendingNote: ARM_ROLES[roleId] ? '' : 'Наполнение по вашей должности — на следующем этапе; задачи уже работают' };
}

// /api/arm — АРМ (свой или подчинённого: ?user=), люди, задачи.
// ctx.notifyUser(userId, text) — адресное уведомление (лента + Telegram).
export async function armApi(ctx) {
  const { db, request, response, pathname, url, user, access, json, errorJson, readJson, audit, requestIp, settingsObject } = ctx;
  if (pathname !== '/api/arm' && !pathname.startsWith('/api/arm/')) return false;
  if (!user) { errorJson(response, 401, 'Требуется вход'); return true; }
  const method = request.method;
  const notify = (userId, text) => { try { ctx.notifyUser?.(userId, text); } catch { /* не критично */ } };
  if (pathname === '/api/arm' && method === 'GET') {
    const targetId = url?.searchParams?.get('user') || user.id;
    const target = targetId === user.id ? user : db.prepare('SELECT * FROM users WHERE id=? AND deleted_at IS NULL').get(targetId);
    if (!target) { errorJson(response, 404, 'Сотрудник не найден'); return true; }
    if (!canView(db, user, access, target)) { errorJson(response, 403, 'Рабочее место сотрудника видит его руководитель'); return true; }
    const targetAccess = target.id === user.id ? access : ctx.accessOf?.(db, target);
    const roleId = targetAccess && !targetAccess.legacy ? armRoleOf(targetAccess.sets || []) : null;
    // Деньги — по уровню смотрящего (руководитель не видит больше своего).
    const money = access?.legacy ? 'full' : access?.money || 'none';
    json(response, 200, { ...armData(db, target, roleId, { settings: settingsObject(db), readOnly: target.id !== user.id,
      park: ctx.parkMonth, money }),
      viewer: { id: user.id, self: target.id === user.id } });
    return true;
  }
  if (pathname === '/api/arm/people' && method === 'GET') {
    json(response, 200, { people: peopleFor(db, user, access), canViewOthers: isHead(access) || isDirection(access) });
    return true;
  }
  if (pathname === '/api/arm/tasks' && method === 'POST') {
    const body = await readJson(request) || {};
    const result = addTask(db, user, access, body);
    if (!result.ok) { errorJson(response, result.status, result.error); return true; }
    audit(db, user, 'create', 'arm_task', result.id, { to: result.to.id, title: body.title }, requestIp(request));
    notify(result.to.id, `☑ Задача от ${user.full_name || user.username}: ${String(body.title).trim()} — срок ${dueLabel(new Date(Date.parse(body.dueAt)).toISOString(), Date.now()).replace('срок ', '')}. Открыть: «Моё рабочее место».`);
    json(response, 201, { id: result.id });
    return true;
  }
  const match = pathname.match(/^\/api\/arm\/tasks\/([^/]+)$/);
  if (match && method === 'POST') {
    const body = await readJson(request) || {};
    const result = taskAction(db, user, decodeURIComponent(match[1]), body.action, body.result);
    if (!result.ok) { errorJson(response, result.status, result.error); return true; }
    audit(db, user, body.action, 'arm_task', result.task.id, { result: body.result || '' }, requestIp(request));
    if (result.notify) {
      const what = { done: '✓ сделано', fail: '✗ не сделано', cancel: 'снята' }[body.action];
      notify(result.notify, `☑ Задача «${result.task.title}» — ${what}${body.result ? `: ${String(body.result).trim()}` : ''} (${user.full_name || user.username}).`);
    }
    json(response, 200, { ok: true });
    return true;
  }
  errorJson(response, 404, 'Маршрут АРМ не найден');
  return true;
}
