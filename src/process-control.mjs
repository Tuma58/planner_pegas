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
  { key: 'sys_speed', stage: 'Система', title: 'Скорость планера', owner: 'staff', screen: '' },
  { key: 'sys_client', stage: 'Система', title: 'Ошибки в браузере у сотрудников', owner: 'staff', screen: '' },
  { key: 'month_close', stage: 'А12–А13', title: 'Закрытие месяца: ФОТ и затраты сверены', owner: 'staff', screen: 'payroll' }
];

// ── Журналы контроля (11.11): ошибки браузера, отказы в доступе,
// закрытие месяца. Суточные агрегаты — без персональных данных сверх
// имени сотрудника и адреса запроса.
export const CLOSE_KINDS = { payroll: 'ФОТ водителей', expenses: 'Затраты' };
const mskDay = (ms = Date.now()) => new Date(ms + 3 * 3_600_000).toISOString().slice(0, 10);

export function recordClientError(db, userName, payload = {}) {
  const message = String(payload.message || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!message) return false;
  db.prepare(`INSERT INTO client_errors(day,message,source,view,user_name,count) VALUES(?,?,?,?,?,1)
    ON CONFLICT(day,message) DO UPDATE SET count=count+1, view=excluded.view, user_name=excluded.user_name,
      source=excluded.source, updated_at=CURRENT_TIMESTAMP`)
    .run(mskDay(), message, String(payload.source || '').slice(0, 120), String(payload.view || '').slice(0, 30),
      String(userName || '').slice(0, 60));
  return true;
}

export function recordDenial(db, userName, pathname) {
  db.prepare(`INSERT INTO access_denials(day,user_name,path,count) VALUES(?,?,?,1)
    ON CONFLICT(day,user_name,path) DO UPDATE SET count=count+1, updated_at=CURRENT_TIMESTAMP`)
    .run(mskDay(), String(userName || '').slice(0, 60), String(pathname || '').slice(0, 80));
}

export function closeMonth(db, month, kind, byName, on = true) {
  if (!/^\d{4}-\d{2}$/.test(String(month)) || !CLOSE_KINDS[kind]) return { ok: false, status: 422, error: 'Месяц ГГГГ-ММ и вид: payroll или expenses' };
  if (month >= mskDay().slice(0, 7)) return { ok: false, status: 422, error: 'Сверяется завершённый месяц' };
  if (on) {
    db.prepare(`INSERT INTO month_closures(month,kind,closed_by) VALUES(?,?,?)
      ON CONFLICT(month,kind) DO UPDATE SET closed_by=excluded.closed_by, closed_at=CURRENT_TIMESTAMP`).run(month, kind, String(byName || ''));
  } else db.prepare(`DELETE FROM month_closures WHERE month=? AND kind=?`).run(month, kind);
  return { ok: true };
}

// Проверки системных журналов для processControl (opts.system).
export function controlJournalChecks(db, { nowMs = Date.now(), settings = {} } = {}) {
  const today = mskDay(nowMs);
  const errors = db.prepare(`SELECT message, view, user_name, count FROM client_errors WHERE day=? ORDER BY count DESC`).all(today);
  const denials = db.prepare(`SELECT user_name, path, count FROM access_denials WHERE day=? ORDER BY count DESC`).all(today);
  const people = [...new Set(denials.map(row => row.user_name))];
  // Прошлый месяц: срок сверки — день месяца из настройки (цель руководителя).
  const now = new Date(nowMs + 3 * 3_600_000);
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
  const deadline = Number(settings.processControl?.monthCloseDay ?? 10);
  const closed = new Map(db.prepare(`SELECT kind, closed_by, closed_at FROM month_closures WHERE month=?`).all(prev).map(row => [row.kind, row]));
  const late = now.getUTCDate() > deadline;
  return {
    sys_client: [
      { label: 'Разных ошибок за сутки', value: errors.length, tone: errors.length ? 'warn' : '',
        note: errors.slice(0, 3).map(row => `${row.message} (${row.view || 'экран ?'}, ${row.user_name}, ×${row.count})`).join('; ') },
      { label: 'Всего срабатываний', value: errors.reduce((sum, row) => sum + row.count, 0), kind: 'metric' }
    ],
    denials: [
      { label: 'Отказы «недостаточно прав» за сутки: людей', value: people.length, tone: people.length ? 'warn' : '',
        note: denials.slice(0, 4).map(row => `${row.user_name} → ${row.path} ×${row.count}`).join('; ') }
    ],
    month_close: Object.entries(CLOSE_KINDS).map(([kind, title]) => {
      const row = closed.get(kind);
      return { label: `${title} за ${prev}`, value: row ? 0 : 1, closeKind: kind, month: prev, closed: Boolean(row),
        tone: row ? '' : late ? 'neg' : 'warn',
        note: row ? `сверено: ${row.closed_by}, ${String(row.closed_at).slice(0, 10)}` : `не сверено · срок — ${deadline}-е число` };
    })
  };
}


export function migrateProcessControl(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS process_control_days (
    day TEXT NOT NULL, key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ok', load REAL,
    details_json TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(day, key))`);
  db.exec(`CREATE TABLE IF NOT EXISTS client_errors (
      day TEXT NOT NULL, message TEXT NOT NULL, source TEXT NOT NULL DEFAULT '', view TEXT NOT NULL DEFAULT '',
      user_name TEXT NOT NULL DEFAULT '', count INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(day, message));
    CREATE TABLE IF NOT EXISTS access_denials (
      day TEXT NOT NULL, user_name TEXT NOT NULL, path TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(day, user_name, path));
    CREATE TABLE IF NOT EXISTS month_closures (
      month TEXT NOT NULL, kind TEXT NOT NULL, closed_by TEXT NOT NULL DEFAULT '',
      closed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(month, kind));`);
  // Цели руководителя: окно истории, перцентиль «хуже обычного», минимум
  // суток для норматива. Дефолт — только вместо пустоты.
  const row = db.prepare(`SELECT value_json FROM settings WHERE key='processControl'`).get();
  if (!row) {
    db.prepare(`INSERT INTO settings(key,value_json) VALUES('processControl',?)`)
      .run(JSON.stringify({ windowDays: 14, alertPercentile: 90, minDays: 5, enabled: true, monthCloseDay: 10 }));
  } else {
    // Срок сверки месяца — цель руководителя; дефолт только вместо пустоты.
    let value = {};
    try { value = JSON.parse(row.value_json) || {}; } catch { value = {}; }
    if (value.monthCloseDay == null) {
      value.monthCloseDay = 10;
      db.prepare(`UPDATE settings SET value_json=? WHERE key='processControl'`).run(JSON.stringify(value));
    }
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

// Потери процесса в деньгах (приоритет оптимизации): простаивающие машины
// × медиана выручки машино-суток парка (живой норматив сегментации
// клиентов, не новая константа). losses: { ключ процесса: { units, label } }.
export function processControl(db, { nowMs = Date.now(), settings = {}, system = {}, park = null, losses = null, dayValue = null } = {}) {
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
    const lost = losses?.[proc.key];
    const loss = lost && dayValue ? { units: lost.units, label: lost.label, perDay: Math.round(lost.units * dayValue) } : null;
    return { key: proc.key, stage: proc.stage, title: proc.title, owner: proc.owner, screen: proc.screen || '',
      loss, status, load, baseline, learning: baseline == null ? `норматив учится: ${loads.length} из ${minDays} сут` : '',
      checks: items, week: past.slice(-7).map(row => ({ day: row.day, status: row.status, load: row.load })) };
  };
  const processes = [
    ...PROCESSES.map(proc => build(proc, runChecks(db, proc, ctx))),
    ...SYSTEM_PROCESSES.map(proc => build(proc, (system[proc.key] || []).map(item => ({ kind: 'row', unit: '', note: '', tone: '', ...item }))))
  ];
  const count = status => processes.filter(proc => proc.status === status).length;
  const lossTotal = processes.reduce((sum, proc) => sum + (proc.loss?.perDay || 0), 0);
  return { day: today, processes, dayValue: dayValue || null, lossTotal,
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
