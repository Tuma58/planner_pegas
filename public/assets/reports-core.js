// «Система отчётов» (проект «Слияние», блок «Мои отчёты», 07.11.2026) —
// чистое ядро без DOM: реестр отчётов по уровням × отделам и фильтр по
// роли-набору. Импортируется и в браузере (reports-hub.js), и в node-тестах.
//
// Принцип: НОВЫХ расчётов нет — каждый пункт реестра указывает на уже
// существующий канон (parkReportData / opsReportData / briefReportData /
// reportSnapshot и т.д. в src/server.mjs) и на то, как его открыть сейчас.
// Дубли не удаляются — помечаются duplicateOf + merge (причина), решение
// «сливаем/удаляем» — за руководителем по счётчику использования (А6).

// Уровни — раскладка 06-processy-i-kontrol.md, «Система отчётов».
export const LEVELS = [
  { id: 'day', title: 'День', hint: 'оперативный срез: вчера и прямо сейчас' },
  { id: 'week', title: 'Неделя', hint: 'управленческий выпуск: нормативы, цели, стыки, подбор' },
  { id: 'period', title: 'Месяц / период', hint: 'отчёт периода с разрезами, печать и PDF' },
  { id: 'process', title: 'Процессы', hint: 'время на шагах, отклонения, конвейер' },
  { id: 'people', title: 'Люди', hint: 'личные показатели и KPI должностей' },
  { id: 'reconcile', title: 'Сверка', hint: 'деньги и эксплуатация против 1С' },
  { id: 'system', title: 'Архив и система', hint: 'история периодов, конфликты, живые нормативы, инвентаризация' }
];

// '' — направление целиком (только область «всё направление»).
export const DEPT_TITLES = { '': 'Направление', staff: 'Штаб', log: 'Логистика', drv: 'Эксплуатация', toir: 'ТОиР' };

export const MONEY_TITLES = { full: 'выручка и итоги', rates: 'ставки', none: 'без денег' };
const RANK = { none: 1, rates: 2, full: 3 };

// Поля пункта:
//   id, level, dept ('' | staff | log | drv | toir), alsoDepts? — отделы,
//   которым пункт уже выдан утверждённым решением (чек-лист 07.11:
//   «Отчёты отдела» руководителя логистики);
//   title, source — функция-канон и маршрут сервера;
//   money — минимальный уровень денег набора;
//   need — что требует СЕРВЕР: 'reports' = requireReports (право
//     reports:read ИЛИ экран отчётов в наборе при деньгах full), иначе код
//     права; все виды openReport сначала зовут /api/reports, поэтому у
//     них всегда есть 'reports';
//   open — { kind } (openReport), { view[, bossView] } (экран),
//     { dialog } (окно модуля) или { feed } (рассылка: приходит в ленту);
//   duplicateOf? — id пункта, который считает то же; merge? — причина
//     «кандидат на слияние»; drop? — причина «кандидат на удаление».
export const REPORTS = [
  // ── День ──
  { id: 'ops', level: 'day', dept: '', title: '📊 Эксплуатация (главная руководителя)',
    source: 'opsReportData(parkReportData) · /ops-report, /api/ops-now', money: 'full', need: ['reports:read'],
    open: { view: 'boss', bossView: 'ops' } },
  { id: 'daily', level: 'day', dept: '', title: '📆 Отчёт дня по автопарку',
    source: 'reportSnapshot(вчера) + /api/attendance · окно в «Руководителе»', money: 'full', need: ['reports'],
    open: { view: 'boss', bossView: 'classic' }, duplicateOf: 'ops',
    merge: 'утренний срез парка считается вторым путём (reportSnapshot) рядом с каноном opsReportData; раскладка А3 — одна утренняя сводка' },
  // Две утренние рассылки слиты 07.11: «Отчёт эксплуатации» 07:15 идёт
  // хвостом единого «Отчёта дня» 07:00 (dailyOpsTail), отдельной рассылки нет.
  { id: 'daily-fleet-feed', level: 'day', dept: '', title: '📆 Рассылка «Отчёт дня» 07:00 (единая утренняя)',
    source: 'runDailyFleetReport → opsReportData(parkReportData) + хвост dailyOpsTail · лента всем + ТГ, деньги по уровню', money: 'none', need: [],
    open: { feed: 'ежедневно 07:00 · лента «Конвейер»' } },
  { id: 'dispatch-shift', level: 'day', dept: 'log', title: 'Смена диспетчерской: план/факт',
    source: 'shiftPlanFact · /api/reports/dispatch-shift', money: 'none', need: ['reports', 'reports:read'],
    open: { kind: 'dispatch-shift' } },
  { id: 'dashboard', level: 'day', dept: '', title: '▦ Дашборд (ТВ-режим)',
    source: 'стартовая выдача + /api/control · тот же каскад, что «Эксплуатация»', money: 'none', need: [],
    open: { view: 'dashboard' } },

  // ── Неделя ──
  { id: 'eff-week', level: 'week', dept: '', title: '📊 Выпуск «Повышение эффективности» — неделя',
    source: 'effReport(opsReportData, parkReportData, reportSnapshot) · /api/efficiency, пт 08:00', money: 'full', need: ['reports:read'],
    open: { view: 'boss', bossView: 'eff' } },
  { id: 'norms-feed', level: 'week', dept: '', title: '📐 Нормативы недели + цели направления',
    source: 'runNormsDigest (variableCostPerKm, смарт-транзит, ворота) · пн 08:00', money: 'full', need: [],
    open: { feed: 'понедельник 08:00 · лента всем' },
    merge: 'одна из четырёх недельных рассылок пн 08:00 — раскладка А3: один недельный выпуск' },
  { id: 'assign-feed', level: 'week', dept: 'log', title: '🎯 Подбор ТС за неделю',
    source: 'runAssignQualityReport · пн 08:00', money: 'none', need: [],
    open: { feed: 'понедельник 08:00 · лента всем' }, duplicateOf: 'norms-feed',
    merge: 'та же минута и та же лента, что «Нормативы недели» — вливается в один недельный выпуск' },
  { id: 'gates-feed', level: 'week', dept: 'log', title: '🚪 Дорогие ворота недели',
    source: 'runGateCostDigest (gateTargetHours) · пн 08:00', money: 'rates', need: [],
    open: { feed: 'понедельник 08:00 · планированию' }, duplicateOf: 'norms-feed',
    merge: 'ворота уже входят в «Нормативы недели» (опора «транзит») — сливается в один недельный выпуск' },
  { id: 'bulletin', level: 'week', dept: '', title: '📰 Вестник недели (табло)',
    source: 'weeklyBulletinData (bulletin.mjs) · пн 08:00 на табло', money: 'full', need: [],
    open: { feed: 'понедельник 08:00 · табло, сутки' } },

  // ── Месяц / период ──
  { id: 'brief', level: 'period', dept: '', title: '⚡ Сводка периода (печать и PDF-колода)',
    source: 'briefReportData (reportSnapshot + mileageData) · /api/brief-report, /api/brief-deck.pdf', money: 'full', need: ['reports'],
    open: { view: 'boss', bossView: 'classic' } },
  { id: 'summary', level: 'period', dept: '', alsoDepts: ['log'], title: 'Сводный отчёт за период',
    source: 'reportSnapshot + канон parkReportData · /api/reports', money: 'full', need: ['reports'],
    open: { kind: 'summary' }, duplicateOf: 'brief',
    merge: 'каскад и выручка периода — те же цифры, что «Сводка периода» и «Эксплуатация»; раскладка А3 — один отчёт периода с разрезами' },
  { id: 'boss-period', level: 'period', dept: '', title: '⋯ Операционный отчёт (экран «Руководитель»)',
    source: 'reportSnapshot + канон opsReportData · /api/reports', money: 'full', need: ['reports:read'],
    open: { view: 'boss', bossView: 'classic' }, duplicateOf: 'summary',
    merge: 'экранная версия «Сводного»: тот же /api/reports, те же каскад, машино-дни, экономика и клиенты' },
  { id: 'eff-month', level: 'period', dept: '', title: '📅 Выпуск «Повышение эффективности» — месяц',
    source: 'effReport · /api/efficiency/issues (kind=month)', money: 'full', need: ['reports:read'],
    open: { view: 'boss', bossView: 'month' }, duplicateOf: 'brief',
    merge: 'итоги месяца в третьем виде рядом со «Сводкой периода» и «Сводным»' },
  { id: 'econ', level: 'period', dept: '', alsoDepts: ['log'], title: 'Экономика по типам ТС',
    source: 'reportSnapshot.byVehicleType · /api/reports', money: 'full', need: ['reports'],
    open: { kind: 'econ' }, duplicateOf: 'summary',
    merge: 'та же таблица «Экономика по типам ТС» уже есть внутри «Сводного» — стать разрезом одного отчёта периода' },
  { id: 'clients', level: 'period', dept: 'log', title: 'Экономика по клиентам',
    source: 'econByClient в reports.js (своя формула переменных по Калькуляции)', money: 'full', need: ['reports'],
    open: { kind: 'clients' }, duplicateOf: 'boss-period',
    merge: 'считается в браузере своей формулой, а не variableCostPerKm() (нарушение п.4 концепции); раздел «Клиенты» экрана руководителя показывает то же — стать разрезом «клиент» на каноне' },
  { id: 'client-fleet', level: 'period', dept: 'log', title: 'Машино-ёмкость клиентов',
    source: 'clientFleetData + variableCostPerKm · /api/reports/client-fleet', money: 'full', need: ['reports'],
    open: { kind: 'client-fleet' } },
  { id: 'vehicles', level: 'period', dept: 'drv', title: 'Аналитика по сцепкам',
    source: 'resourceStats · /api/resource-stats', money: 'full', need: ['reports', 'planner:read'],
    open: { kind: 'vehicles' } },
  { id: 'speed', level: 'period', dept: 'log', title: 'Скорости парка (Vт / Vэ)',
    source: '/api/reports/speed (GPS + живые нормы скоростей)', money: 'none', need: ['reports', 'reports:read'],
    open: { kind: 'speed' } },
  { id: 'mileage', level: 'period', dept: 'drv', title: '🛣 Пробеги парка',
    source: 'mileageData (журнал одометров 00:00 МСК) · /api/mileage-report', money: 'none', need: ['reports:read'],
    open: { dialog: 'mileage' } },
  { id: 'ring-load', level: 'period', dept: 'log', title: '⭕ Загрузка кругов',
    source: 'ringLoadData · /api/ring-load', money: 'full', need: ['planner:read'],
    open: { dialog: 'ring-load' },
    merge: 'круги показаны трижды: «План парка», «⭕ Круги» в Планировании и здесь (А2) — оставить одно место' },
  { id: 'cfo', level: 'period', dept: '', title: '₽ ЦФО и затраты отдела',
    source: '/api/cfo (блок 3 «Слияния»)', money: 'full', need: [],
    open: { view: 'cfo' } },
  { id: 'remzona-load', level: 'period', dept: 'toir', title: '🔧 Загрузка ремзоны на 14 дней',
    source: '/api/shift-planner', money: 'none', need: ['planner:read'],
    open: { view: 'boss', bossView: 'classic' } },

  // ── Процессы ──
  { id: 'deviations', level: 'process', dept: 'log', title: 'Отклонения конвейера',
    source: 'deviationsFor в reports.js (стартовая выдача)', money: 'none', need: ['reports'],
    open: { kind: 'deviations' },
    merge: 'раскладка А3: вместе со стыками «160 млн» и «Отчётом за смену» — в панель процессов' },
  { id: 'execution', level: 'process', dept: 'log', title: 'Контроль выполнения рейсов',
    source: '/api/control (точки рейсов, опоздания П/В)', money: 'none', need: ['reports', 'planner:read'],
    open: { kind: 'execution' } },
  { id: 'shift', level: 'process', dept: 'log', title: '🕐 Отчёт за смену (12 ч)',
    source: '/api/shift-report (операции по именам, очереди каскада)', money: 'none', need: ['reports:read'],
    open: { dialog: 'shift' }, duplicateOf: 'dispatch-shift',
    merge: 'передача смены считается ещё в runShiftDigestWatch и runEveningHandoff (А4 п.3) — одна передача смены по процессам' },
  { id: 'shift-feed', level: 'process', dept: 'log', title: '🌙 Сводка смены и передача на ночь',
    source: 'runShiftDigestWatch (утро/вечер) + runEveningHandoff 17:30–22:00', money: 'none', need: [],
    open: { feed: 'утро и вечер · лента, логисту и диспетчеру' }, duplicateOf: 'shift',
    merge: 'два сторожа об одной передаче смены (А4 п.3)' },
  { id: 'project160', level: 'process', dept: '', title: '🎯 Проект «160 млн»: стыки и эффект',
    source: '/api/project160', money: 'full', need: ['reports:read'],
    open: { dialog: 'project160' } },
  { id: 'demurrage', level: 'process', dept: 'log', title: '⏳ Простои П/В и претензии',
    source: '/api/demurrage (договорной простой)', money: 'rates', need: ['planner:read'],
    open: { dialog: 'demurrage' } },
  { id: 'rejected', level: 'process', dept: 'log', title: 'Отклонённые рейсы',
    source: 'стартовая выдача (trips.status=rejected)', money: 'none', need: ['reports'],
    open: { kind: 'rejected' }, duplicateOf: 'summary',
    merge: 'та же таблица «Отклонённые рейсы за период» уже внутри «Сводного»' },
  { id: 'rejected-orders', level: 'process', dept: 'log', title: 'Реестр заявок (подтверждённые / отклонённые)',
    source: 'стартовая выдача (orders)', money: 'rates', need: ['reports'],
    open: { kind: 'rejected-orders' } },

  // ── Люди ──
  { id: 'kpi', level: 'people', dept: '', alsoDepts: ['log', 'drv', 'toir'], title: '◎ KPI и каскад',
    source: '/api/kpi (блок 4 «Слияния»)', money: 'none', need: [],
    open: { view: 'kpi' } },
  { id: 'staff', level: 'people', dept: 'staff', title: 'Показатели сотрудников',
    source: 'staffReport · /api/reports/staff', money: 'rates', need: ['reports', 'reports:read'],
    open: { kind: 'staff' }, duplicateOf: 'kpi',
    merge: 'раскладка А3: личные показатели → KPI должностей (блок 4); источник personal в kpi.js уже ссылается сюда' },
  { id: 'my-shift', level: 'people', dept: '', alsoDepts: ['log'], title: '🏅 Моя смена',
    source: '/api/my-shift (дашборд)', money: 'none', need: [],
    open: { view: 'dashboard' }, duplicateOf: 'kpi',
    merge: 'личная сводка сотрудника конвейера — вместе с «Показателями сотрудников» в KPI должностей' },
  { id: 'drivers', level: 'people', dept: 'drv', title: 'Водители: профиль и дисциплина',
    source: 'driverPeriodMetrics · /api/reports/drivers, PDF /reports/drivers/pdf', money: 'none', need: ['reports', 'reports:read'],
    open: { kind: 'drivers' } },

  // ── Сверка ──
  { id: 'reconcile', level: 'reconcile', dept: '', title: '⚖ Сверка 1С (деньги)',
    source: 'reconcileOrders в reconcile.js + /api/reconciliation (история снимков)', money: 'full', need: ['reports'],
    open: { dialog: 'reconcile' } },
  { id: 'park-1c', level: 'reconcile', dept: '', title: '🏭 Сверка эксплуатации с 1С (каскад по часам)',
    source: 'park-report.js — расчёт в браузере из xlsx 1С', money: 'none', need: ['reports'],
    open: { dialog: 'park-1c' }, duplicateOf: 'ops',
    drop: 'несравним с каноном с 05.11 (раскладка А3) — кандидат на удаление' },

  // ── Архив и система ──
  { id: 'history', level: 'system', dept: '', title: 'История периодов',
    source: '/api/periods/history (закрытые периоды)', money: 'full', need: ['reports', 'reports:read'],
    open: { kind: 'history' } },
  { id: 'conflicts', level: 'system', dept: '', title: 'История конфликтов',
    source: 'стартовая выдача (пересечения рейсов)', money: 'none', need: ['reports'],
    open: { kind: 'conflicts' } },
  { id: 'self-tuning', level: 'system', dept: '', title: '🧠 Живые нормативы',
    source: '/api/self-tuning (реестр самообучающихся процессов)', money: 'none', need: ['reports:read'],
    open: { dialog: 'self-tuning' } },
  { id: 'inventory', level: 'system', dept: '', title: '🧾 Инвентаризация процессов',
    source: '/api/inventory?scope=all', money: 'none', need: ['planner:read'],
    open: { dialog: 'inventory' } }
];

// Экраны, дающие requireReports «без reports:read» (сервер, 07.11):
// 'logreports' сегодня; 'reports' — предложение для нового экрана.
const REPORT_VIEWS = ['reports', 'logreports'];

const legacyOf = access => !access || access.legacy;

function deptOk(access, report) {
  if (legacyOf(access) || access.scope?.all) return true;
  const depts = access.scope?.depts || [];
  return [report.dept, ...(report.alsoDepts || [])].some(dept => dept && depts.includes(dept));
}

// Право «Отчёты (чтение, с ценами)» (reports:read) открывает отчёты с
// деньгами и роли без денег — решение руководителя 07.11.
function moneyOk(access, report, allowed = () => false) {
  if (allowed('reports:read')) return true;
  const have = RANK[access?.money] || RANK.none;
  return have >= (RANK[report.money] || RANK.none);
}

function viewOk(access, report) {
  if (legacyOf(access) || !report.open?.view) return true;
  return (access.views || []).includes(report.open.view);
}

// Причина, по которой СЕРВЕР не отдаст отчёт ('' — отдаст).
function gateReason(access, can, report) {
  for (const need of report.need || []) {
    if (need === 'reports') {
      const viaView = !legacyOf(access) && access.money === 'full'
        && (access.views || []).some(view => REPORT_VIEWS.includes(view));
      if (!can('reports:read') && !viaView) return 'сервер: право reports:read или экран отчётов при деньгах «выручка»';
    } else if (!can(need)) return `сервер: право ${need}`;
  }
  return '';
}

const safeCan = can => (typeof can === 'function' ? permission => Boolean(can(permission)) : () => false);

// Отчёты, которые роль видит и может открыть. Переходный период (наборов
// нет, legacy) — всё, что даёт can('reports:read'), с проверкой прав
// сервера; с наборами — область (отдел), уровень денег, экран в наборе и
// права сервера.
export function reportsFor(access, can, list = REPORTS) {
  const allowed = safeCan(can);
  if (legacyOf(access) && !allowed('reports:read')) return [];
  return list.filter(report => deptOk(access, report) && moneyOk(access, report, allowed)
    && viewOk(access, report) && !gateReason(access, allowed, report));
}

// Отчёты своего отдела и своего уровня денег, которые сервер сегодня НЕ
// отдаёт этой роли, — показываются серым с причиной, чтобы руководитель
// видел дыру прав, а не пустой экран. Legacy — пусто.
export function reportsLocked(access, can, list = REPORTS) {
  if (legacyOf(access)) return [];
  const allowed = safeCan(can);
  return list.filter(report => deptOk(access, report) && moneyOk(access, report, allowed) && viewOk(access, report))
    .map(report => ({ report, reason: gateReason(access, allowed, report) }))
    .filter(item => item.reason);
}

// Группировка по уровням в порядке LEVELS; пустые уровни выпадают.
export function groupByLevel(list) {
  return LEVELS.map(level => ({ ...level, items: list.filter(report => report.level === level.id) }))
    .filter(level => level.items.length);
}

// Сводка дублей для руководителя: пункты с duplicateOf / merge / drop.
export function mergeCandidates(list = REPORTS) {
  const byId = new Map(list.map(report => [report.id, report]));
  return list.filter(report => report.duplicateOf || report.merge || report.drop).map(report => ({
    id: report.id, title: report.title, level: report.level,
    duplicateOf: report.duplicateOf ? byId.get(report.duplicateOf)?.title || report.duplicateOf : '',
    verdict: report.drop ? 'кандидат на удаление' : 'кандидат на слияние',
    reason: report.drop || report.merge || ''
  }));
}
