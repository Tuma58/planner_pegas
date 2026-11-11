// Контроль процессов (заказ руководителя 11.11: «ни один процесс не
// должен оставаться без контроля, отладки и оптимизации»).
// Реестр процессов конвейера «заявка → деньги» и сквозных контуров: у
// каждого — владелец, проверки и рабочий экран. Проверки — НЕ новые
// формулы: те же каноны очередей и показателей, что сотрудник видит в
// своём АРМ (armWidget), плюс системные (сторожа, скорость, входы).
// Норматив «хуже обычного» — живой: перцентиль собственной истории
// процесса за окно (настройка processControl), без зашитых порогов;
// пока истории мало — только факт. Сторож пишет суточный след и
// сообщает руководителю о ПЕРЕХОДАХ (стало хуже / восстановилось).

import { armWidget } from './arm.mjs';

export const PROCESSES = [
  { key: 'clients', stage: 'А1–А2', title: 'Клиенты, договоры, новые клиенты', owner: 'log', screen: 'crm',
    checks: [['leads'], ['lead_steps'], ['claims_new']] },
  { key: 'orders', stage: 'А3', title: 'Заявки и согласование', owner: 'log', screen: 'sales',
    checks: [['orders_queue']] },
  { key: 'assign', stage: 'А4', title: 'Назначение машин', owner: 'log', screen: 'logist',
    checks: [['log_queues_assign'], ['next_share']] },
  { key: 'crew', stage: 'А5', title: 'Экипаж и выпуск на линию', owner: 'drv', screen: 'release',
    checks: [['drv_shift_queue'], ['attendance_today'], ['release_today'], ['release_requests']] },
  { key: 'tech', stage: 'А6', title: 'Техготовность: ремонт, ТО, запчасти', owner: 'toir', screen: 'remzona',
    checks: [['toir_queues'], ['repair_on_time'], ['parts_buy']] },
  { key: 'gate', stage: 'А7', title: 'КПП: въезд и выезд', owner: 'staff', screen: 'gate',
    checks: [['gate']] },
  { key: 'trip', stage: 'А8–А9', title: 'Рейс в пути и выгрузка', owner: 'log', screen: 'dispatcher',
    checks: [['log_queues_ctrl'], ['late_unload']] },
  { key: 'docs', stage: 'А10', title: 'Документы после выгрузки', owner: 'drv', screen: 'docs',
    checks: [['docs_waiting'], ['docs_norm']] },
  { key: 'pay', stage: 'А11', title: 'Оплата клиента и наличные', owner: 'staff', screen: 'payments',
    checks: [['paid_week'], ['cash_collect']] },
  { key: 'people', stage: 'А12', title: 'Люди: явка и текучесть водителей', owner: 'drv', screen: 'resource',
    checks: [['attendance_yesterday'], ['turnover_month']] },
  { key: 'safety', stage: 'БДД', title: 'Безопасность движения', owner: 'staff', screen: 'safety',
    checks: [['safety_exec']] },
  { key: 'joints', stage: 'Стыки', title: 'Стыки отделов: сигналы без ответа', owner: 'staff', screen: 'field',
    checks: [['joint_cases', 'drv_log', 'field'], ['joint_cases', 'toir_drv', 'field'], ['joint_cases', 'log_toir', 'field']] },
  { key: 'feedback', stage: 'Обратная связь', title: 'HELP DESK и тех. задания без решения', owner: 'staff', screen: '',
    checks: [['helpdesk_new']] }
];
// Системные процессы — проверки приходят от сервера (opts.system).
export const SYSTEM_PROCESSES = [
  { key: 'sys_access', stage: 'Система', title: 'Доступ: входы и временные пароли', owner: 'staff', screen: 'staff' },
  { key: 'sys_watch', stage: 'Система', title: 'Сторожа и фоновые расчёты', owner: 'staff', screen: '' },
  { key: 'sys_speed', stage: 'Система', title: 'Скорость планера', owner: 'staff', screen: '' }
];

export function migrateProcessControl(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS process_control_days (
    day TEXT NOT NULL, key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ok', load REAL,
    details_json TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(day, key))`);
  // Цели руководителя: окно истории, перцентиль «хуже обычного», минимум
  // суток для норматива. Дефолт — только вместо пустоты.
  const row = db.prepare(`SELECT value_json FROM settings WHERE key='processControl'`).get();
  if (!row) {
    db.prepare(`INSERT INTO settings(key,value_json) VALUES('processControl',?)`)
      .run(JSON.stringify({ windowDays: 14, alertPercentile: 90, minDays: 5, enabled: true }));
  }
}

const RANK = { none: 0, ok: 1, work: 2, bad: 3 };
const dayOf = ms => new Date(ms + 3 * 3_600_000).toISOString().slice(0, 10); // сутки МСК

function percentile(values, q) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q / 100))];
}

// Проверка → {label, value, note, tone}; «нагрузка» процесса — сумма
// счётчиков очередей (строки и задачи), показатели (metric) в неё не
// входят: у них свой тон по норме.
function runChecks(db, proc, ctx) {
  const items = [];
  for (const [key, ...args] of proc.checks) {
    for (const item of armWidget(key, ctx, ...args)) {
      if (!item || item.kind === 'task' && !item.label) continue;
      items.push({ label: item.label, value: item.kind === 'task' ? 1 : item.value ?? null, unit: item.unit || '',
        note: item.note || item.tag || '', tone: item.tone || '', kind: item.kind, source: item.source || key });
    }
  }
  return items;
}

function statusOf(items, load, baseline) {
  if (!items.length) return 'none';
  if (items.some(item => item.tone === 'neg')) return 'bad';
  if (baseline != null && load > baseline) return 'bad';
  if (load > 0 || items.some(item => item.tone === 'warn')) return 'work';
  return 'ok';
}

export function processControl(db, { nowMs = Date.now(), settings = {}, system = {}, park = null } = {}) {
  const cfg = settings.processControl || {};
  const windowDays = Number(cfg.windowDays ?? 14);
  const minDays = Number(cfg.minDays ?? 5);
  const pct = Number(cfg.alertPercentile ?? 90);
  const today = dayOf(nowMs);
  const from = dayOf(nowMs - windowDays * 864e5);
  const history = db.prepare(`SELECT day, key, status, load FROM process_control_days
    WHERE day>=? AND day<? ORDER BY day`).all(from, today);
  const ctx = { db, user: null, nowMs, settings, money: 'none', park: () => park };
  const build = (proc, items) => {
    const load = items.filter(item => item.kind !== 'metric' && typeof item.value === 'number')
      .reduce((sum, item) => sum + item.value, 0);
    const past = history.filter(row => row.key === proc.key);
    const loads = past.map(row => row.load).filter(value => value != null);
    const baseline = loads.length >= minDays ? percentile(loads, pct) : null;
    const status = statusOf(items, load, baseline);
    return { key: proc.key, stage: proc.stage, title: proc.title, owner: proc.owner, screen: proc.screen || '',
      status, load, baseline, learning: baseline == null ? `норматив учится: ${loads.length} из ${minDays} сут` : '',
      checks: items, week: past.slice(-7).map(row => ({ day: row.day, status: row.status, load: row.load })) };
  };
  const processes = [
    ...PROCESSES.map(proc => build(proc, runChecks(db, proc, ctx))),
    ...SYSTEM_PROCESSES.map(proc => build(proc, (system[proc.key] || []).map(item => ({ kind: 'row', unit: '', note: '', tone: '', ...item }))))
  ];
  const count = status => processes.filter(proc => proc.status === status).length;
  return { day: today, processes,
    summary: { total: processes.length, ok: count('ok'), work: count('work'), bad: count('bad'), blind: count('none') },
    settings: { windowDays, minDays, alertPercentile: pct, enabled: cfg.enabled !== false } };
}

// Тик сторожа: суточный след (худший статус и наибольшая нагрузка дня) и
// переходы относительно прошлого тика — о них сообщается руководителю.
export function processControlTick(db, opts = {}) {
  const data = processControl(db, opts);
  const upsert = db.prepare(`INSERT INTO process_control_days(day,key,status,load,details_json) VALUES(?,?,?,?,?)
    ON CONFLICT(day,key) DO UPDATE SET
      status=CASE WHEN ?>? THEN excluded.status ELSE process_control_days.status END,
      load=MAX(COALESCE(process_control_days.load,0), COALESCE(excluded.load,0)),
      details_json=excluded.details_json, updated_at=CURRENT_TIMESTAMP`);
  const prevDay = new Map(db.prepare(`SELECT key, status FROM process_control_days WHERE day=?`).all(data.day).map(row => [row.key, row.status]));
  for (const proc of data.processes) {
    upsert.run(data.day, proc.key, proc.status, proc.load, JSON.stringify(proc.checks.slice(0, 12)),
      RANK[proc.status], RANK[prevDay.get(proc.key)] || 0);
  }
  let last = {};
  try { last = JSON.parse(db.prepare(`SELECT value FROM app_meta WHERE key='process_control_last'`).get()?.value || '{}'); } catch { last = {}; }
  const now = Object.fromEntries(data.processes.map(proc => [proc.key, proc.status]));
  db.prepare(`INSERT INTO app_meta(key,value) VALUES('process_control_last',?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(JSON.stringify(now));
  const first = !Object.keys(last).length;
  const worse = first ? [] : data.processes.filter(proc => proc.status === 'bad' && last[proc.key] !== 'bad');
  const better = first ? [] : data.processes.filter(proc => last[proc.key] === 'bad' && proc.status !== 'bad' && proc.status !== 'none');
  const blind = first ? [] : data.processes.filter(proc => proc.status === 'none' && last[proc.key] && last[proc.key] !== 'none');
  return { data, worse, better, blind };
}

export function processAlertText({ worse, better, blind }) {
  const line = proc => {
    const top = proc.checks.filter(item => item.tone === 'neg' || (item.kind !== 'metric' && item.value > 0))
      .slice(0, 2).map(item => `${item.label}${item.value != null ? ` — ${item.value}${item.unit || ''}` : ''}`).join('; ');
    return `${proc.stage} «${proc.title}»${top ? `: ${top}` : ''}${proc.baseline != null && proc.load > proc.baseline ? ` (обычно до ${proc.baseline})` : ''}`;
  };
  const parts = [];
  if (worse.length) parts.push(`🔴 Хуже обычного: ${worse.map(line).join(' · ')}`);
  if (blind.length) parts.push(`⚫ Нет данных контроля: ${blind.map(proc => `${proc.stage} «${proc.title}»`).join(' · ')}`);
  if (better.length) parts.push(`🟢 Восстановилось: ${better.map(proc => `${proc.stage} «${proc.title}»`).join(' · ')}`);
  return parts.length ? `🧭 Контроль процессов. ${parts.join('. ')}. Экран: Настройки → «Контроль процессов».` : '';
}
