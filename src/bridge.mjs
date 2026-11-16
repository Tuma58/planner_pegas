// 🧭 «Мостик недели» — еженедельный обзор руководителя по Фридману
// (заказ 14.11.2026): одна поверхность вместо кусков. Четыре списка —
// выполнено, сорвано с причинами, наступившие точки контроля,
// перенесённое дважды и больше; рядом «окна хаоса» (факт внепланового
// по неделям, медиана вместо зашитого порога — живой норматив) и
// висяки дерева целей. Выгрузка «ПЛАН НЕДЕЛИ» собирается клиентом из
// этих же данных — текст для планёрки.
import { goalsOrphans } from './goals.mjs';

const WEEK = 7 * 864e5;

// Понедельник 00:00 МСК недели, в которую попадает момент.
export function weekStart(nowMs) {
  const msk = new Date(nowMs + 3 * 3_600_000);
  const shift = (msk.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(msk.getUTCFullYear(), msk.getUTCMonth(), msk.getUTCDate() - shift) - 3 * 3_600_000);
}

const iso = ms => new Date(ms).toISOString();
// Подпись дня по МСК: московская полночь в UTC — вчера, прямой slice врёт.
const mskDay = ms => new Date(ms + 3 * 3_600_000).toISOString().slice(0, 10);

export function bridgeData(db, { nowMs = Date.now(), weeksBack = 0 } = {}) {
  const start = weekStart(nowMs).getTime() - weeksBack * WEEK;
  const end = start + WEEK;
  const now = iso(nowMs);
  const task = row => ({ id: row.id, title: row.title, from: row.from_name, to: row.to_name,
    due: row.due_at, control: row.control_at, status: row.status, result: row.result,
    postpones: row.postpone_count || 0, log: safeLog(row.postpone_log) });
  // 1. Выполнено за неделю: задачи и заявки/ТЗ.
  const doneTasks = db.prepare(`SELECT * FROM arm_tasks WHERE status='done' AND closed_at>=? AND closed_at<?
    ORDER BY closed_at DESC LIMIT 100`).all(iso(start), iso(end)).map(task);
  const doneTickets = db.prepare(`SELECT kind, problem, author_name FROM helpdesk_tickets
    WHERE status='done' AND updated_at>=? AND updated_at<? ORDER BY updated_at DESC LIMIT 100`)
    .all(iso(start).slice(0, 19).replace('T', ' '), iso(end).slice(0, 19).replace('T', ' '));
  // 2. Сорвано: «не сделано» с причиной + просроченные открытые.
  const failed = db.prepare(`SELECT * FROM arm_tasks WHERE status='failed' AND closed_at>=? AND closed_at<?
    ORDER BY closed_at DESC LIMIT 100`).all(iso(start), iso(end)).map(task);
  const overdue = db.prepare(`SELECT * FROM arm_tasks WHERE status IN ('new','work') AND due_at<?
    ORDER BY due_at LIMIT 100`).all(now).map(task);
  // 3. Контроль: наступившие точки по открытым делегированным.
  const controls = db.prepare(`SELECT * FROM arm_tasks WHERE status IN ('new','work')
    AND control_at IS NOT NULL AND control_at<=? ORDER BY control_at LIMIT 100`).all(now).map(task);
  // 4. Перенесённое ≥2 раз — кандидат на дробление/делегирование/снятие.
  const rebounced = db.prepare(`SELECT * FROM arm_tasks WHERE status IN ('new','work')
    AND postpone_count>=2 ORDER BY postpone_count DESC, due_at LIMIT 100`).all().map(task);
  // Очередь недели вперёд: открытые задачи со сроком в ближайшие 7 дней.
  const queue = db.prepare(`SELECT * FROM arm_tasks WHERE status IN ('new','work')
    AND due_at>=? AND due_at<? ORDER BY due_at LIMIT 100`).all(now, iso(nowMs + WEEK)).map(task);
  // «Окна хаоса»: внеплановое по неделям (4 назад + текущая) — внештатки,
  // решения «поверх диспозиции», новые заявки HELP DESK. Порога нет:
  // медиана прошлых недель и служит ориентиром доли резерва.
  const weeks = [];
  for (let back = 4; back >= 0; back -= 1) {
    const ws = weekStart(nowMs).getTime() - back * WEEK;
    const we = ws + WEEK;
    // created_at бывает в двух написаниях ('…T…Z' и '… …') — приводим
    // к одному прямо в запросе, чтобы не считать дважды и не терять.
    const between = (table, column) => db.prepare(
      `SELECT COUNT(*) n FROM ${table} WHERE replace(${column},'T',' ')>=? AND replace(${column},'T',' ')<?`)
      .get(iso(ws).slice(0, 19).replace('T', ' '), iso(we).slice(0, 19).replace('T', ' ')).n;
    weeks.push({ week: mskDay(ws),
      incidents: between('trip_incidents', 'created_at'),
      overrides: between('dispo_overrides', 'created_at'),
      tickets: between('helpdesk_tickets', 'created_at') });
  }
  const median = values => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : 0;
  };
  const past = weeks.slice(0, -1);
  const chaos = { weeks, median: {
    incidents: median(past.map(w => w.incidents)),
    overrides: median(past.map(w => w.overrides)),
    tickets: median(past.map(w => w.tickets)) } };
  return {
    weekFrom: mskDay(start), weekTo: mskDay(end - 864e5),
    done: { tasks: doneTasks, tickets: doneTickets },
    failed, overdue, controls, rebounced, queue, chaos,
    goals: goalsOrphans(db),
    summary: { done: doneTasks.length + doneTickets.length, failed: failed.length,
      overdue: overdue.length, controls: controls.length, rebounced: rebounced.length }
  };
}

function safeLog(text) {
  try { return JSON.parse(text || '[]').slice(-5); } catch { return []; }
}
