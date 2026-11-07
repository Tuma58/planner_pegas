import { renderEfficiency } from './efficiency.js';
// Блок руководителя — операционный отчёт АТП (по образцу отчёта
// «Пегас-Авто» за период): секции с якорной навигацией, KPI-полоса
// с планами и отклонениями, каскад-воронка КТГ→КВЛ→КИП с потерями по
// владельцам, баланс машино-дней, экономика по типам ТС и топ клиентов.
// Тема «панель приборов» (спидометры, лобовое стекло) выведена из продукта.
// Данные — GET /api/reports (сервер) + рейсы bootstrap для кривой и клиентов.
import { directionGoals } from './goals-core.js';
import { inventoryDialog } from './inventory.js';
import { selfTuningDialog } from './self-tuning.js';
import { ringLoadDialog } from './ring-load.js';
import { api, escapeHtml, toast, rangePickerHtml, wireRangePicker, dayPickerHtml, wireDayPicker, captureScrolls, restoreScrolls, tripBusyFromMs, tripBusyUntilMs } from './api.js';
import { demurrageDialog } from './demurrage.js';
import { reconcileDialog } from './reconcile.js';
import { project160Dialog } from './project160.js';
import { shiftDialog } from './shift-report.js';
import { deliveryPlanDialog } from './delivery-plan.js';
import { parkReportDialog } from './park-report.js';

const rub = value => `${Math.round(Number(value || 0)).toLocaleString('ru-RU')} ₽`;
const mln = value => `${(Number(value || 0) / 1e6).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} млн`;
const pct = (value, digits = 1) => `${(value * 100).toFixed(digits)}%`;
const n1 = value => Number(value || 0).toLocaleString('ru-RU', { maximumFractionDigits: 1 });
const n0 = value => Math.round(Number(value || 0)).toLocaleString('ru-RU');

// Плановые уровни каскада — как в операционном отчёте АТП.
// Цели каскада — из реестра целей направления (Настройки → Цели
// направления, 07.11); обновляются на каждом рендере вкладки.
const pctGoal = value => `${String(+(value * 100).toFixed(1)).replace('.', ',')}%`;
let PLAN = { ktg: 0.97, kvl: 0.99, kip: 0.99 };
const devPP = (fact, plan) => (fact - plan) * 100;
const pillCls = d => d >= 0 ? 'g' : (d >= -3 ? 'w' : 'b');

const monthOf = iso => `${String(iso).slice(0, 7)}-01`;
const fmtDay = iso => new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' })
  .format(new Date(`${iso}T00:00:00Z`));

// Лёгкий SVG-график «выручка нарастающим итогом»: факт-полилиния с заливкой
// и пунктир плана — без внешних библиотек (продукт работает офлайн).
function cumChart(fact, plan, labels) {
  const W = 1000, H = 240, padL = 56, padR = 14, padT = 12, padB = 26;
  const maxY = Math.max(1, ...fact, ...plan) * 1.06;
  const x = i => padL + (W - padL - padR) * (fact.length > 1 ? i / (fact.length - 1) : 0);
  const y = v => padT + (H - padT - padB) * (1 - v / maxY);
  const pts = arr => arr.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const gridLines = [0.25, 0.5, 0.75, 1].map(f =>
    `<line x1="${padL}" x2="${W - padR}" y1="${y(maxY * f).toFixed(1)}" y2="${y(maxY * f).toFixed(1)}" class="brep-grid"/>
     <text x="${padL - 8}" y="${(y(maxY * f) + 4).toFixed(1)}" class="brep-tick" text-anchor="end">${(maxY * f / 1e6).toFixed(0)} млн</text>`).join('');
  const ticksX = labels.map((label, i) =>
    (i % Math.ceil(labels.length / 10) === 0 || i === labels.length - 1)
      ? `<text x="${x(i).toFixed(1)}" y="${H - 8}" class="brep-tick" text-anchor="middle">${label}</text>` : '').join('');
  const area = `M${x(0)},${y(0)} L${pts(fact)} L${x(fact.length - 1)},${y(0)} Z`;
  return `<svg viewBox="0 0 ${W} ${H}" class="brep-chart" preserveAspectRatio="none">
    ${gridLines}${ticksX}
    <path d="${area}" class="brep-area"/>
    <polyline points="${pts(plan)}" class="brep-plan"/>
    <polyline points="${pts(fact)}" class="brep-fact"/>
  </svg>`;
}

// Выручка без НДС рейса — единое правило (ИП 7%).
const lowVat = (name, calc) => (calc.vat7Customers || [])
  .includes(String(name || '').toLowerCase().replace(/\s+/g, ' ').trim())
  || /(?<![\p{L}\p{N}])ИП(?![\p{L}\p{N}])/iu.test(name || '');
const tripNet = (trip, calc) => trip.revenue_vat / (1 + (trip.cash ? 0 : lowVat(trip.customer_name, calc)
  ? Number(calc.individualEntrepreneurVatRate ?? 0.07) : Number(calc.vatRate ?? 0.22)));

// Шапка трёх горизонтов (проект «Повышение эффективности», 09.10):
// Сегодня (эксплуатация + «прямо сейчас») · Неделя (презентация) ·
// Месяц (выпуски месяцев) · «⋯» — классическая консоль отчётов,
// в ней ничего не потеряно.
function bossTabs(state, active) {
  const tab = (key, label) => `<button class="button small ${active === key ? '' : 'ghost'}"
    data-boss-tab="${key}">${label}</button>`;
  return `<div class="boss-viewbar">
    ${tab('ops', '📍 Сегодня')}
    ${tab('eff', '📊 Неделя')}
    ${tab('month', '📅 Месяц')}
    ${tab('classic', '⋯ Отчёты и инструменты')}
  </div>`;
}
// Память вида между обновлениями страницы (жалоба руководителя 09.10:
// F5 сбрасывал на «Сегодня») — наш паттерн свёрток с localStorage.
const BOSS_VIEW_KEY = 'pl_boss_view';
const savedBossView = () => {
  try {
    const value = localStorage.getItem(BOSS_VIEW_KEY);
    return ['ops', 'eff', 'month', 'classic'].includes(value) ? value : null;
  } catch { return null; }
};
const rememberBossView = view => { try { localStorage.setItem(BOSS_VIEW_KEY, view); } catch {} };
function wireBossTabs(container, context) {
  container.querySelectorAll('[data-boss-tab]').forEach(button =>
    button.onclick = () => {
      context.state.bossView = button.dataset.bossTab;
      rememberBossView(button.dataset.bossTab);
      renderBoss(container, context);
    });
}

export async function renderBoss(container, context) {
  {
    const goals = directionGoals(context.state.data?.settings?.calculation);
    PLAN = { ktg: goals.ktg / 100, kvl: goals.kvl / 100, kip: goals.kip / 100 };
  }
  const { state } = context;
  if (!state.bossView) state.bossView = savedBossView() || 'ops';
  // Вид «Неделя»: живая презентация эффективности (пт 08:00 — автосборка).
  if (state.bossView === 'eff' || state.bossView === 'month') {
    const isMonth = state.bossView === 'month';
    if (!container.querySelector('#effHost') || container.dataset.bossTab !== state.bossView) {
      container.dataset.bossTab = state.bossView;
      container.innerHTML = `${bossTabs(state, state.bossView)}<div id="effHost"></div>`;
      wireBossTabs(container, context);
      const host = container.querySelector('#effHost');
      if (isMonth) {
        // Месяц: последний месячный выпуск (или живой расчёт месяца к дате).
        const issues = (await api('/api/efficiency/issues').catch(() => ({ items: [] }))).items;
        state.effIssues = issues;
        const monthIssue = issues.find(item => item.kind === 'month');
        if (monthIssue) renderEfficiency(host, context, { issueId: monthIssue.id });
        else {
          const today = new Date().toISOString().slice(0, 10);
          state.effFrom = `${today.slice(0, 7)}-01`;
          state.effTo = today;
          renderEfficiency(host, context, {});
        }
      } else {
        const issues = (await api('/api/efficiency/issues').catch(() => ({ items: [] }))).items;
        state.effIssues = issues;
        const weekIssue = issues.find(item => item.kind === 'week');
        if (weekIssue) renderEfficiency(host, context, { issueId: weekIssue.id });
        else renderEfficiency(host, context, {});
      }
    }
    return;
  }
  // Главная руководителя (конструкция утверждена 21.09): первый экран —
  // «Эксплуатация» (строка «прямо сейчас» + отчёт за период), прежние
  // показатели периода целиком живут в «⋯», ничего не потеряно.
  if ((state.bossView || 'ops') === 'ops') {
    // Щит iframe (жалоба руководителя 22.09): тик автообновления звал
    // renderBoss заново, iframe пересоздавался — слетали выбранные внутри
    // отчёта период и тема. Вид уже живёт — не трогаем DOM вовсе (даже
    // перенос узла iframe перезагружает его содержимое).
    if (container.querySelector('#opsFrame')) return;
    container.dataset.bossTab = 'ops';
    container.innerHTML = `${bossTabs(state, 'ops')}<div class="bi-page boss-ops">
      <div class="ops-now" id="opsNow">⏳ прямо сейчас: считаю…</div>
      <section class="section boss-frame"><div class="sec-b flush">
        <iframe id="opsFrame" title="Отчёт эксплуатации"></iframe></div></section></div>`;
    wireBossTabs(container, context);
    const frame = container.querySelector('#opsFrame');
    const appTheme = document.documentElement.dataset.theme ||
      (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    frame.src = `/ops-report?theme=${appTheme}`;
    const fit = () => { frame.style.height = `${Math.max(700, window.innerHeight - frame.getBoundingClientRect().top - 14)}px`; };
    fit();
    const nowBox = container.querySelector('#opsNow');
    const refreshNow = async () => {
      if (!nowBox.isConnected) return;
      try {
        const now = await api('/api/ops-now');
        const idleTxt = now.idle.length
          ? `⚠ без заказа и причины: <b>${now.idle.length}</b> (${now.idle.slice(0, 5)
            .map(item => `${item.plate} с ${item.since}`).join(', ')}${now.idle.length > 5 ? '…' : ''})`
          : '✅ без заказа и причины: 0';
        nowBox.innerHTML = `Прямо сейчас: в пути <b>${now.run}</b> · ${idleTxt}` +
          ` · график: покрытие плана <b>${now.coverage}%</b> (гейт этапа 3 — ${now.gate}%)`;
      } catch { nowBox.textContent = 'прямо сейчас: нет данных'; }
      setTimeout(refreshNow, 60_000);
    };
    refreshNow();
    return;
  }
  const monthIso = state.month.toISOString().slice(0, 10);
  // Дата «по» включительная: дефолт — ПОСЛЕДНИЙ день месяца, а не 1-е
  // следующего (старый дефолт давал октябрю «32 дн», «оставшиеся 14» и
  // «нужно/сут» ниже дашборда — замечание руководителя 19.10). Сохранённый
  // период-пережиток «1-е…1-е следующего» тоже приводим к месяцу.
  const monthEnd = new Date(Date.UTC(state.month.getUTCFullYear(),
    state.month.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  const nextFirst = new Date(Date.UTC(state.month.getUTCFullYear(),
    state.month.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
  if (state.bossFrom === monthIso && state.bossTo === nextFirst) state.bossTo = monthEnd;
  const from = state.bossFrom || monthIso;
  const to = state.bossTo || monthEnd;
  let report;
  try {
    report = await api(`/api/reports?from=${from}&to=${to}`);
  } catch (error) {
    container.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    return;
  }
  const u = report.utilization;
  // Канон (решение руководителя 22.09): каскад, состав машино-дней и
  // средние — те же цифры, что «Отчёт эксплуатации» и утренние сводки.
  // Переопределяем поля до использования — все формулы ниже наследуют.
  if (report.canon) {
    const C = report.canon;
    const fleetN = C.total.fleet || u.vehicles;
    const days = C.total.days || u.days || 1;
    const techAvg = Math.max(0, fleetN - C.downtime.repair.avg - C.downtime.out.avg);
    // Каскад по «Рабочей среде СТ» (05.11): КВЛ — укомплектованность
    // исправных (вычет без водителя/пересменки), КИП — с заданием от
    // укомплектованных; произведение = доля календаря с заданием.
    const crewAvg = Math.max(0, techAvg - C.downtime.no_driver.avg - C.downtime.shift.avg);
    u.vehicles = fleetN;
    u.days = days;
    u.futureDays = Math.max(0, (u.periodDays || days) - days);
    u.calendarDays = fleetN * days;
    u.techDays = techAvg * days;
    u.lineDays = crewAvg * days;
    u.workDays = C.avgOnline * days;
    u.ktg = fleetN ? techAvg / fleetN : 0;
    u.kvl = techAvg ? crewAvg / techAvg : 0;
    u.kip = crewAvg ? Math.min(1, C.avgOnline / crewAvg) : 0;
    u.machineDays = {
      work: Math.round(u.workDays),
      idle: Math.round(C.downtime.no_reason.avg * days),
      noDriver: Math.round(C.downtime.no_driver.avg * days),
      shift: Math.round(C.downtime.shift.avg * days),
      repair: Math.round(C.downtime.repair.avg * days),
      out: Math.round(C.downtime.out.avg * days)
    };
  }
  const md = u.machineDays;
  const calc = state.data.settings.calculation;
  const planPeriod = monthOf(from);
  const periodLabel = new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(`${planPeriod}T00:00:00Z`));
  const revenuePlan = Number((state.data.revenuePlans || [])
    .find(item => item.period_start === planPeriod)?.target_net || 0);

  // Рейсы периода по дате выполнения — для кривой и клиентов.
  const periodTrips = state.data.trips.filter(trip => trip.status !== 'rejected' &&
    trip.ends_at >= `${from}T00:00:00` && trip.ends_at < `${to}T00:00:00`);

  // ── KPI-полоса ──
  const planDev = revenuePlan ? (report.netRevenue - revenuePlan) / revenuePlan * 100 : null;
  const fondUse = u.calendarDays ? u.workDays / u.calendarDays : 0;
  const kpiCells = [
    { k: 'Выручка без НДС · забито', v: mln(report.netRevenue),
      p: `выгружено ${mln(report.netRevenueDone || 0)}${revenuePlan ? ` · план ${mln(revenuePlan)}` : ' · план не задан'}`,
      pill: planDev == null ? null : `${planDev >= 0 ? '+' : ''}${planDev.toFixed(1)}%`,
      pc: planDev == null ? 'w' : (planDev >= 0 ? 'g' : 'b'),
      g: revenuePlan ? report.netRevenue / revenuePlan : 0, c: 'var(--ok)', cls: 'dept-staff hero' },
    { k: 'КТГ — техготовность', v: pct(u.ktg), p: `план ${pctGoal(PLAN.ktg)}`,
      pill: `${devPP(u.ktg, PLAN.ktg) >= 0 ? '+' : ''}${devPP(u.ktg, PLAN.ktg).toFixed(1)} п.п.`,
      pc: pillCls(devPP(u.ktg, PLAN.ktg)), g: u.ktg / PLAN.ktg, c: 'var(--toir)', cls: 'dept-toir' },
    { k: 'КВЛ — укомплектованность', v: pct(u.kvl), p: `план ${pctGoal(PLAN.kvl)}`,
      pill: `${devPP(u.kvl, PLAN.kvl) >= 0 ? '+' : ''}${devPP(u.kvl, PLAN.kvl).toFixed(1)} п.п.`,
      pc: pillCls(devPP(u.kvl, PLAN.kvl)), g: u.kvl / PLAN.kvl, c: 'var(--drv)', cls: 'dept-drv' },
    { k: 'КИП — с заданием', v: pct(u.kip), p: `с заданием ${n1(u.workDays / Math.max(1, u.days))} ед. из ${u.vehicles}`,
      pill: `${devPP(u.kip, PLAN.kip) >= 0 ? '+' : ''}${devPP(u.kip, PLAN.kip).toFixed(1)} п.п.`,
      pc: pillCls(devPP(u.kip, PLAN.kip)), g: u.kip / PLAN.kip, c: 'var(--log)', cls: 'dept-log' },
    { k: 'Использование парка — итог каскада', v: pct(fondUse), p: `${n0(u.workDays)} из ${n0(u.calendarDays)} машино-дней`,
      pill: `${devPP(fondUse, u.utilizationTarget) >= 0 ? '+' : ''}${devPP(fondUse, u.utilizationTarget).toFixed(1)} п.п.`,
      pc: pillCls(devPP(fondUse, u.utilizationTarget)), g: u.utilizationTarget ? fondUse / u.utilizationTarget : 0, c: 'var(--staff)', cls: 'dept-staff' }
  ];
  // Плитка «Рейсы» — те же report.trips и средний чек, что в разделе 01.
  kpiCells.splice(1, 0, { k: 'Рейсы завершено', v: n0(report.trips),
    p: `${n1(report.trips / Math.max(1, u.days))} в сутки · ср. чек ${report.trips ? rub(report.netRevenue / report.trips) : '—'}`,
    pill: null, pc: null, g: null, c: null, cls: '' });
  // BI-плитки .metric: цвет отдела — полоса сверху, тон отклонения — цифра и тег.
  const tone = pc => pc === 'g' ? 'good' : pc === 'w' ? 'warn' : pc === 'b' ? 'bad' : '';
  const tagCls = pc => pc === 'g' ? 'pos' : pc === 'w' ? 'warn' : 'neg';
  const kpiHtml = kpiCells.map(x => `<div class="metric ${x.cls}">
    <span class="l">${x.k}</span>
    <span class="v ${tone(x.pc)}">${x.v}</span>
    <span class="d">${x.p}</span>
    ${x.pill ? `<span class="bi-tag ${tagCls(x.pc)} boss-kpi-tag">${x.pill}</span>` : ''}
    ${x.g != null ? `<div class="bi-meter"><i style="width:${Math.min(x.g * 100, 100)}%;background:${x.c}"></i></div>` : ''}
  </div>`).join('');

  // ── 01 Период: план/факт + кривая нарастающим итогом ──
  const dayCount = Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000));
  const dayLabels = [];
  const dailyNet = Array(dayCount).fill(0);
  for (let day = 0; day < dayCount; day += 1) {
    dayLabels.push(fmtDay(new Date(Date.parse(from) + day * 86_400_000).toISOString().slice(0, 10)));
  }
  for (const trip of periodTrips) {
    const idx = Math.floor((Date.parse(trip.ends_at) - Date.parse(from)) / 86_400_000);
    if (idx >= 0 && idx < dayCount) dailyNet[idx] += tripNet(trip, calc);
  }
  let acc = 0;
  const cumFact = dailyNet.map(value => (acc += value));
  const cumPlan = dayLabels.map((_, i) => revenuePlan ? revenuePlan / dayCount * (i + 1) : 0);
  // Смыслы — как на дашборде (сверка 19.10): «забито» = выгружено +
  // назначенное с выгрузкой в периоде; «нужно/сут» = остаток плана от
  // выгруженного ДО сегодня на остаток дней, ВКЛЮЧАЯ сегодня.
  const booked = report.bookedNet ?? report.netRevenue;
  const done = revenuePlan ? booked / revenuePlan : 0;
  const gap = revenuePlan ? booked - revenuePlan : 0;
  const needDaily = revenuePlan && report.remainingDays
    ? Math.max(0, revenuePlan - (report.netPast ?? report.netRevenue)) / report.remainingDays : null;
  // Раздел 01 — две секции сетки: график (s8, несёт якорь) + план/факт (s4).
  const secHead = (idx, title, hint, actions = '') => `<div class="sec-h">
      ${idx ? `<span class="sn">${idx}</span>` : ''}<span class="st">${title}</span>
      ${hint ? `<span class="hint">${hint}</span>` : ''}${actions ? `<div class="sec-actions">${actions}</div>` : ''}</div>`;
  const kvRow = (k, v, sub = '', cls = '') => `<tr><td>${k}${sub ? `<div class="boss-sub">${sub}</div>` : ''}</td>
    <td class="num ${cls}"><b>${v}</b></td></tr>`;
  const periodSection = `<section id="brep-s1" class="section s8 dept-staff">
    ${secHead('01', 'Выручка нарастающим итогом', `без НДС, по дате выполнения${revenuePlan ? ' · пунктир — план равномерно по дням' : ''}`,
    `<span class="bi-tag">${fmtDay(from)} – ${fmtDay(to)} · ${u.periodDays || u.days} дн</span>`)}
    <div class="sec-b">
      ${revenuePlan ? `<div class="brep-pbar boss-pbar"><i style="width:${Math.min(100, done * 100).toFixed(1)}%"></i><em>план 100%</em></div>` : ''}
      ${cumChart(cumFact, cumPlan, dayLabels)}
      <div class="boss-note">${u.futureDays
    ? `Учтено ${u.days} дн из ${u.periodDays || u.days} (будущие ${u.futureDays} в машино-дни не входят) · ` : ''}выручка по дате выгрузки</div>
    </div>
  </section>
  <section class="section s4">
    ${secHead('', 'План / факт периода', '')}
    <div class="sec-b flush"><table class="bi-table rtable boss-kv"><tbody>
      ${kvRow('План без НДС', revenuePlan ? mln(revenuePlan) : '—',
    revenuePlan ? `${rub(revenuePlan / dayCount)}/сут` : 'задайте в консоли')}
      ${kvRow('Забито без НДС', mln(booked),
      `выгружено ${mln(report.netRevenue)} · факт ${rub(report.netRevenue / Math.max(1, u.days))}/сут в среднем`)}
      ${kvRow('Выполнение', revenuePlan ? pct(done) : '—',
        revenuePlan ? `забито к плану · выгружено ${pct(report.netRevenue / revenuePlan)}` : '',
        done >= 1 ? 'good' : done >= 0.9 ? 'warn' : 'bad')}
      ${kvRow(gap >= 0 ? 'Запас' : 'Не забито', revenuePlan ? mln(Math.abs(gap)) : '—',
          revenuePlan && gap < 0 ? (needDaily != null
            ? `нужно ${rub(needDaily)}/сут оставшиеся ${report.remainingDays} дн — как на дашборде`
            : 'период прошёл — цель не добрана') : '', gap >= 0 ? 'good' : 'bad')}
      ${kvRow('Рейсов завершено в периоде', report.trips)}
      ${kvRow('Средний чек без НДС', report.trips ? rub(report.netRevenue / report.trips) : '—')}
      ${kvRow('Сцепок в работе (среднее)', n1(u.workDays / Math.max(1, u.days)))}
      ${kvRow('Выручка на сцепку в сутки', u.workDays ? rub(report.netRevenue / u.workDays) : '—')}
    </tbody></table></div>
  </section>`;

  // ── 02 Каскад КТГ → КВЛ → КИП ──
  const perDay = value => value / Math.max(1, u.days);
  const steps = [
    { n: 'Списочный парк', v: u.vehicles, loss: null, c: 'var(--faint)' },
    { n: 'Технически исправны', v: perDay(u.techDays), loss: u.vehicles - perDay(u.techDays),
      c: 'var(--toir)', own: 'ТОиР', kn: 'КТГ', k: u.ktg, pl: PLAN.ktg },
    { n: 'Выпущены на линию', v: perDay(u.lineDays), loss: perDay(u.techDays) - perDay(u.lineDays),
      c: 'var(--drv)', own: 'Водители', kn: 'КВЛ', k: u.kvl, pl: PLAN.kvl },
    { n: 'В работе', v: perDay(u.workDays), loss: perDay(u.lineDays) - perDay(u.workDays),
      c: 'var(--log)', own: 'Логистика', kn: 'КИП', k: u.kip, pl: PLAN.kip }
  ];
  const cascadeHtml = steps.map((s, i) => {
    const wv = s.v / u.vehicles * 100;
    const wl = s.loss ? s.loss / u.vehicles * 100 : 0;
    const d = s.k != null ? devPP(s.k, s.pl) : null;
    return `<div class="brep-step">
      <div class="t"><span class="n">${i === 3 ? `<b>${s.n}</b>` : s.n}</span>
        <span class="val">${n1(s.v)}<small> ед.</small></span></div>
      <div class="bar"><i style="width:${wv.toFixed(1)}%;background:${s.c}"></i>
        <em style="width:${Math.max(0, wl).toFixed(1)}%"></em></div>
      <div class="m"><span>${s.kn
        ? `${s.kn} <b>${pct(s.k)}</b> · план ${pct(s.pl, 0)} <span class="bi-tag ${({ g: 'pos', w: 'warn', b: 'neg' })[pillCls(d)]}">${d >= 0 ? '+' : ''}${d.toFixed(1)}</span>`
        : `база каскада · ${pct(perDay(u.workDays) / u.vehicles)} парка доходит до работы`}</span>
        <span>${s.own ? `${s.own} <b class="bad">−${n1(s.loss)}</b>` : ''}</span></div>
    </div>`;
  }).join('');
  const lossRows = [
    ['ТОиР', u.vehicles - perDay(u.techDays), 'var(--toir)'],
    ['Водители', perDay(u.techDays) - perDay(u.lineDays), 'var(--drv)'],
    ['Логистика', perDay(u.lineDays) - perDay(u.workDays), 'var(--log)']
  ];
  const lossSum = lossRows.reduce((sum, row) => sum + row[1], 0);
  const cascadeSection = `<section id="brep-s2" class="section s7">
    ${secHead('02', 'Каскад КТГ → КВЛ → КИП', 'среднесуточные единицы парка · потери по владельцам процессов')}
    <div class="sec-b">${cascadeHtml}</div>
  </section>
  <section class="section s5">
    ${secHead('', 'Куда уходит парк', `простой ${n1(lossSum)} ед./сут в среднем за период`)}
    <div class="sec-b flush">
        <table class="bi-table rtable"><thead><tr><th>Владелец</th><th class="num">Ед./сут</th><th class="num">Маш-дней</th><th class="num">Доля</th></tr></thead><tbody>
        ${lossRows.map(([name, value, color]) => `<tr>
          <td><span class="dotc" style="background:${color}"></span>${name}</td>
          <td class="num">${n1(value)}</td>
          <td class="num">${n0(value * u.days)}</td>
          <td class="num">${lossSum ? Math.round(value / lossSum * 100) : 0}%</td></tr>`).join('')}
        <tr class="tot"><td>Итого простой</td><td class="num">${n1(lossSum)}</td>
          <td class="num">${n0(lossSum * u.days)}</td><td class="num">100%</td></tr>
        </tbody></table>
        <p class="brep-hint boss-pad">Рейсов за период ${report.trips} · ${n1(report.trips / Math.max(1, u.days))} в сутки
          · ${u.workDays ? n1(report.trips / u.workDays) : '—'} на работающую сцепку.</p>
    </div>
  </section>`;

  // ── 03 Машино-дни: баланс календарного фонда ──
  const fondParts = [
    { n: 'В работе', v: md.work, c: 'var(--log)', own: '—' },
    { n: 'Без заказа', v: md.idle, c: 'color-mix(in srgb, var(--log) 50%, var(--card))', own: 'логистика' },
    { n: 'Без водителя', v: md.noDriver, c: 'var(--drv)', own: 'водители' },
    { n: 'Пересменка', v: md.shift, c: 'color-mix(in srgb, var(--drv) 50%, var(--card))', own: 'водители' },
    { n: 'Ремонт', v: md.repair, c: 'var(--toir)', own: 'ТОиР' },
    { n: 'Выведены', v: md.out, c: 'var(--faint)', own: '—' }
  ].filter(part => part.v > 0);
  const stackHtml = fondParts.map(part =>
    `<div style="width:${(part.v / u.calendarDays * 100).toFixed(2)}%;background:${part.c}"
      title="${part.n}: ${n0(part.v)} м-дн">${part.v / u.calendarDays > 0.045 ? pct(part.v / u.calendarDays, 1) : ''}</div>`).join('');
  const lostVsNorm = Math.max(0, u.normDays - u.workDays);
  const mdSection = `<section id="brep-s3" class="section">
    ${secHead('03', 'Машино-дни', `${u.vehicles} сцепок × ${u.days} дн = ${n0(u.calendarDays)} машино-дней · норма ${pct(u.utilizationTarget, 1)}`)}
    <div class="sec-b">
      <div class="brep-stack">${stackHtml}</div>
      <div class="brep-slegend">${fondParts.map(part =>
        `<span><span class="dotc" style="background:${part.c}"></span>${part.n} — ${n0(part.v)} м-дн</span>`).join('')}</div>
    </div>
    <div class="sec-b flush">
      <table class="bi-table rtable"><thead><tr><th>Статья</th><th>Владелец</th>
        <th class="num">Маш-дней</th><th class="num">Доля фонда</th><th class="num">Ед./сут</th></tr></thead><tbody>
        ${fondParts.map(part => `<tr><td><span class="dotc" style="background:${part.c}"></span>${part.n}</td>
          <td class="muted">${part.own}</td><td class="num">${n0(part.v)}</td>
          <td class="num">${pct(part.v / u.calendarDays)}</td>
          <td class="num">${n1(part.v / Math.max(1, u.days))}</td></tr>`).join('')}
        <tr class="tot"><td>Календарный фонд</td><td>—</td><td class="num">${n0(u.calendarDays)}</td>
          <td class="num">100%</td><td class="num">${n1(u.vehicles)}</td></tr>
      </tbody></table>
      <p class="brep-hint boss-pad">Потеря против нормы — <b>${n0(lostVsNorm)}</b> машино-дней
        (${n1(lostVsNorm / Math.max(1, u.days))} сцепки в сутки). По марж. доходу
        ${rub(u.marginPerTripDay)} за машино-день это <b>${mln(u.lostProfit)} ₽</b> упущенного дохода за период.</p>
    </div>
  </section>`;

  // ── 04 Экономика ──
  const types = [...report.byVehicleType].sort((a, b) => b.netRevenue - a.netRevenue);
  const maxPerDay = Math.max(1, ...types.map(t => t.netRevenue / Math.max(1, u.days)));
  const ecoSection = `<section id="brep-s4" class="section s5 dept-staff">
    ${secHead('04', 'Экономика · P&L', 'выручка без НДС · переменные и постоянные по нормативам настроек')}
    <div class="sec-b"><div class="bi-list">
        <div class="bi-row"><span class="k">Выручка без НДС</span><span class="v">${rub(report.netRevenue)}</span></div>
        <div class="bi-row"><span class="k">− Переменные (путевые, страх./дороги, водитель, ХОУ)</span><span class="v">${rub(report.netRevenue - report.contribution)}</span></div>
        <div class="bi-row"><span class="k">= Маржинальный доход</span><span class="v">${rub(report.contribution)}</span></div>
        <div class="bi-row"><span class="k">− Постоянные (лизинг + накладные · ${u.vehicles}×${u.days} маш-дней)</span><span class="v">${rub(report.fixed)}</span></div>
        <div class="bi-row boss-big"><span class="k">= Операционная прибыль</span><span class="v ${report.operationalProfit < 0 ? 'bad' : ''}">${rub(report.operationalProfit)}</span></div>
        <div class="bi-row"><span class="k">Операционная маржа</span><span class="v">${pct(report.operationalMargin)}</span></div>
        <div class="bi-row"><span class="k">Марж. доход на машино-день</span><span class="v">${rub(u.marginPerTripDay)}</span></div>
    </div></div>
  </section>
  <section class="section s7">
    ${secHead('', 'По типам ТС', 'полоса — выручка в сутки')}
    <div class="sec-b flush">
        <table class="bi-table rtable"><thead><tr><th>Тип</th><th class="num">Рейсов</th>
          <th class="num">Выручка б.НДС</th><th class="num">В сутки</th><th class="num">Опер. маржа</th></tr></thead><tbody>
        ${types.map(t => {
          const per = t.netRevenue / Math.max(1, u.days);
          const margin = t.netRevenue ? t.operationalProfit / t.netRevenue : 0;
          return `<tr><td>${escapeHtml(t.vehicleType)}
            <div class="brep-mini"><i style="width:${(per / maxPerDay * 100).toFixed(1)}%"></i></div></td>
          <td class="num">${t.trips}</td><td class="num">${rub(t.netRevenue)}</td>
          <td class="num">${rub(per)}</td>
          <td class="num ${margin < 0 ? 'bad' : margin < 0.1 ? 'warn' : 'good'}">${pct(margin)}</td></tr>`;
        }).join('')}
        </tbody></table>
    </div>
  </section>`;

  // ── 05 Топ клиентов периода ──
  const byClient = new Map();
  for (const trip of periodTrips) {
    const item = byClient.get(trip.customer_name) || { name: trip.customer_name, trips: 0, net: 0 };
    item.trips += 1;
    item.net += tripNet(trip, calc);
    byClient.set(trip.customer_name, item);
  }
  const clients = [...byClient.values()].sort((a, b) => b.net - a.net);
  const top = clients.slice(0, 10);
  const totalNet = clients.reduce((sum, client) => sum + client.net, 0);
  const topShare = totalNet ? top.reduce((sum, client) => sum + client.net, 0) / totalNet : 0;
  const maxClient = top[0]?.net || 1;
  const clientsSection = `<section id="brep-s5" class="section">
    ${secHead('05', 'Топ-10 клиентов', `${clients.length} заказчиков за период · топ-10 дают ${pct(topShare, 0)} выручки`)}
    <div class="sec-b flush">
      <table class="bi-table rtable"><thead><tr><th>Заказчик</th><th class="num">Рейсов</th>
        <th class="num">Выручка б.НДС</th><th class="num">Доля</th><th class="num">Средний чек</th></tr></thead><tbody>
      ${top.map((client, i) => `<tr>
        <td><span class="muted mono" style="font-size:var(--fs-xs)">${String(i + 1).padStart(2, '0')}</span>
          ${escapeHtml(client.name)}
          <div class="brep-mini"><i style="width:${(client.net / maxClient * 100).toFixed(1)}%"></i></div></td>
        <td class="num">${client.trips}</td><td class="num">${rub(client.net)}</td>
        <td class="num">${totalNet ? pct(client.net / totalNet) : '—'}</td>
        <td class="num">${rub(client.net / client.trips)}</td></tr>`).join('')}
      </tbody></table>
    </div>
  </section>`;

  // ── Сборка ──
  const savedScrolls = captureScrolls(container);
  container.dataset.bossTab = 'classic';
  container.innerHTML = `${bossTabs(state, 'classic')}<div class="bi-page bosswrap boss-bi">
    <div class="bi-sub"><h2>Операционный отчёт</h2>
      <p>${fmtDay(from)} – ${fmtDay(to)} · ${u.periodDays || u.days} дн · парк ${u.vehicles} сцепок
        · НДС 22%, ИП 7% · рейс по дате выгрузки</p></div>
    <section class="section boss-cabin">
      ${secHead('', 'Кабина руководителя', 'период, план выручки, печатные отчёты и инструменты')}
      <div class="sec-b flush"><div class="console">
        ${rangePickerHtml('bossFrom', 'bossTo', from, to, 'период')}
        <span class="cnl" style="margin-left:10px">План выручки</span>
        <input type="number" id="bossPlan" placeholder="цель, ₽" value="${revenuePlan || ''}" style="width:130px">
        <button class="button ghost small" id="bossClose" title="Зафиксировать период в истории">🏁 Закрыть период</button>
        <input id="bossSearch" class="block-search" placeholder="Поиск по странице"
          title="Фильтрует строки всех таблиц отчёта" style="margin-left:auto;width:170px">
        <select id="bossReportKind">
          <option value="summary">Сводный</option>
          <option value="staff">Показатели сотрудников</option>
          <option value="deviations">Отклонения конвейера</option>
          <option value="econ">Экономика по типам ТС</option><option value="clients">Экономика по клиентам</option>
          <option value="rejected">Отклонённые рейсы</option>
          <option value="execution">Контроль выполнения рейсов</option>
          <option value="vehicles">Аналитика по сцепкам</option>
          <option value="conflicts">История конфликтов</option>
          <option value="rejected-orders">Реестр заявок (подтверждённые/отклонённые)</option>
          <option value="speed">Скорости парка (техническая/эксплуатационная)</option>
          <option value="drivers">Водители: профиль и дисциплина</option>
          <option value="client-fleet">Машино-ёмкость клиентов</option>
          <option value="dispatch-shift">Смена диспетчерской: план/факт</option>
          <option value="history">История периодов</option>
        </select>
        <button class="button small" id="bossReport">📄 Сформировать</button>
        <button class="button ghost small" id="bossDaily"
          title="Ежедневный отчёт по использованию автопарка: срез состояний, выручка и порожняк за день">📆 Отчёт дня</button>
        <button class="button ghost small" id="bossDemurrage"
          title="Простой под погрузкой/выгрузкой: случаи сверх норматива, история претензий, печать документа на счёт">⏳ Простои П/В</button>
        <button class="button ghost small" id="bossReconcile"
          title="Загрузить выгрузку 1С «Заказы для отчёта» (.xlsx) и сверить с планером: излишки, недостающие заказы, расхождения сумм и НДС">⚖ Сверка 1С</button>
        <button class="button ghost small" id="bossProject160"
          title="Внутренний проект развития: где стоит время между ролями, сколько действий стоит работа, что дали изменения продукта">🎯 Проект 160</button>
        <button class="button ghost small" id="bossShift"
          title="Отчёт за 12-часовую смену (08–20 / 20–08): операции сотрудников по именам, время обработки заданий, очереди каскада">🕐 Смена</button>
        <button class="button ghost small" id="bossDeliveryPlan"
          title="Визуальный график вывоза грузов от клиентов на месяц: слоты, заявки, ресурс и выручка план-факт">📅 План вывоза</button>
        <button class="button ghost small" id="bossShiftPlanner"
          title="Загрузка ремзоны на 14 дней: кто в ремонте/пересменке, кто заезжает и выходит, пики против живой нормы и рекомендации переносов">🔧 Ремзона</button>
        <button class="button ghost small" id="bossRingLoad"
          title="Загрузка кругов: план машин по шаблонам при живом зазоре стыковки, факт недели по плечам, дыра и её цена в марже">⭕ Загрузка кругов</button>
        <button class="button ghost small" id="bossSelfTuning"
          title="Реестр самообучающихся процессов: имена, что каждый учит, текущее выученное значение, кламп и где смотреть дрейф">🧠 Живые нормативы</button>
        <button class="button ghost small" id="bossInventory"
          title="Инвентаризация всех процессов: ресурс (дубли прицепов, забытые машины, висящие рейсы, дыры по водителям) + заявки с ошибочными датами, застрявшие стадии, дыры адресов">🧾 Инвентаризация</button>
        <button class="button small" id="bossViewOpsBack"
          title="Вернуться на первый экран: отчёт эксплуатации со строкой «прямо сейчас»">📊 Эксплуатация</button>
        <button class="button ghost small" id="bossBrief"
          title="Короткая сводка периода для доклада на совещании: на линии, заказы, км, опоздания, план/факт выручки и темп — одной страницей, с копированием текста">⚡ Сводка периода</button>
        <button class="button ghost small" id="bossMileage"
          title="Пробеги парка за период до минуты: общий / гружёный / порожний, среднесуточный против цели — одометр CAN на границах периода, при сбое GPS-трек, затем дневной кэш">🛣 Пробеги</button>
        <button class="button ghost small" id="bossParkReport"
          title="СВЕРКА с выгрузками 1С (Заказы/Путевые листы/Ремонты): каскад по часам под грузом из внешнего источника — для сличения с планерным каноном, не для оперативной работы">🏭 Сверка эксплуатации с 1С</button>
      </div></div>
    </section>
    <div class="bi-kpis">${kpiHtml}</div>
    <nav class="boss-anchors" id="brepNav" aria-label="Разделы отчёта">
      <a href="#brep-s1" class="on"><b>01</b> Период</a><a href="#brep-s2"><b>02</b> Каскад</a>
      <a href="#brep-s3"><b>03</b> Машино-дни</a><a href="#brep-s4"><b>04</b> Экономика</a>
      <a href="#brep-s5"><b>05</b> Клиенты</a>
    </nav>
    <div class="bi-grid">${periodSection}${cascadeSection}${mdSection}${ecoSection}${clientsSection}</div>
    <div class="geohint boss-foot">Отклонения — в процентных пунктах к плану (КТГ 97, КВЛ 99, КИП 99,
      фонд ${pct(u.utilizationTarget, 1)}). Печатные формы — через «📄 Сформировать».</div>
  </div>`;
  restoreScrolls(container, savedScrolls);

  // ── Ежедневный отчёт по использованию автопарка ──
  const dailyDialog = () => {
    const defaultDay = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const fmtDayLong = iso => new Intl.DateTimeFormat('ru-RU',
      { weekday: 'short', day: 'numeric', month: 'long', timeZone: 'UTC' })
      .format(new Date(`${iso}T12:00:00Z`));
    const renderDay = async dayIso => {
      const box = document.getElementById('bossDailyBody');
      box.innerHTML = '<p class="muted">Считаю…</p>';
      const dayStart = Date.parse(`${dayIso}T00:00:00Z`);
      const dayEnd = dayStart + 86_400_000;
      const nextIso = new Date(dayEnd).toISOString().slice(0, 10);
      let snap = null;
      try { snap = await api(`/api/reports?from=${dayIso}&to=${nextIso}`); }
      catch { box.innerHTML = '<p class="muted">Отчёт за день недоступен.</p>'; return; }
      const data = state.data;
      // Состояние каждой сцепки на день: рейс по пересечению → диспозиция
      // по большему пересечению → простой (методика ячеек Ганта).
      const buckets = { trip: [], repair: [], shift: [], no_driver: [], reserve: [], idle: [] };
      data.vehicles.filter(vehicle => vehicle.status === 'work').forEach(vehicle => {
        // Занятость по факту: с вывода на линию до фактической выгрузки
        // (незавершённый рейс — до «сейчас»), а не по плановым датам.
        const hasTrip = data.trips.some(trip => trip.vehicle_id === vehicle.id &&
          trip.status !== 'rejected' &&
          tripBusyFromMs(trip) < dayEnd && tripBusyUntilMs(trip) > dayStart);
        if (hasTrip) { buckets.trip.push(vehicle); return; }
        const covering = (data.dispositions || []).filter(item =>
          item.vehicle_id === vehicle.id &&
          Date.parse(item.starts_at) < dayEnd && Date.parse(item.ends_at) > dayStart)
          .sort((a, b) =>
            (Math.min(Date.parse(b.ends_at), dayEnd) - Math.max(Date.parse(b.starts_at), dayStart)) -
            (Math.min(Date.parse(a.ends_at), dayEnd) - Math.max(Date.parse(a.starts_at), dayStart)))[0];
        if (covering && buckets[covering.kind]) { buckets[covering.kind].push(vehicle); return; }
        buckets.idle.push(vehicle);
      });
      const fleet = data.vehicles.filter(vehicle => vehicle.status === 'work').length;
      const u = snap.utilization || {};
      const dayTrips = data.trips.filter(trip => trip.status !== 'rejected' &&
        Date.parse(trip.ends_at) > dayStart && Date.parse(trip.ends_at) <= dayEnd);
      const chipList = (list, extra) => list.length
        ? `<div class="task-chips">${list.map(vehicle => `<span class="tt-chip mono"
            title="${escapeHtml(vehicle.driver_name || '')}">${escapeHtml(vehicle.plate)}${extra
              ? escapeHtml(extra(vehicle)) : ''}</span>`).join('')}</div>`
        : '<p class="muted" style="margin:2px 0">нет</p>';
      const idleSince = vehicle => {
        const last = data.trips.filter(trip => trip.vehicle_id === vehicle.id &&
          trip.status !== 'rejected' && Date.parse(trip.ends_at) <= dayEnd)
          .sort((a, b) => b.ends_at.localeCompare(a.ends_at))[0];
        if (!last) return '';
        const days = Math.floor((dayEnd - Date.parse(last.ends_at)) / 86_400_000);
        return days > 0 ? ` · ${days} дн` : '';
      };
      const pctOf = value => `${Math.round((value || 0) * 100)}%`;
      // Активность смены: внесено и назначено заявок, средний чек внесённого.
      const tsMs = value => value ? Date.parse(String(value).replace(' ', 'T') +
        (String(value).includes('Z') || String(value).includes('+') ? '' : 'Z')) : NaN;
      const createdDay = (data.orders || []).filter(order => order.status !== 'cancelled' &&
        tsMs(order.created_at) >= dayStart && tsMs(order.created_at) < dayEnd);
      const createdSum = createdDay.reduce((sum, order) => {
        const vat = order.cash ? 0 : lowVat(order.customer_name, state.data.settings.calculation)
          ? Number(state.data.settings.calculation.individualEntrepreneurVatRate ?? 0.07)
          : Number(state.data.settings.calculation.vatRate ?? 0.22);
        return sum + Number(order.rate_vat || 0) / (1 + vat);
      }, 0);
      const assignedDay = data.trips.filter(trip => trip.status !== 'rejected' &&
        trip.order_id && trip.source_system !== '1c' &&
        tsMs(trip.created_at) >= dayStart && tsMs(trip.created_at) < dayEnd).length;
      // Дневной план: остаток месячного плана на остаток дней (на дату отчёта).
      const dayDate = new Date(dayStart);
      const mStart = Date.UTC(dayDate.getUTCFullYear(), dayDate.getUTCMonth(), 1);
      const mEnd = Date.UTC(dayDate.getUTCFullYear(), dayDate.getUTCMonth() + 1, 1);
      const daysInMonth = Math.round((mEnd - mStart) / 86_400_000);
      const remainingFromDay = daysInMonth - dayDate.getUTCDate() + 1;
      const monthPlanRow = (state.data.revenuePlans || [])
        .find(item => item.period_start === new Date(mStart).toISOString().slice(0, 10));
      const monthPlan = Number(monthPlanRow?.target_net || 0) || 160_000_000;
      const factBefore = data.trips.filter(trip => trip.status !== 'rejected' &&
        Date.parse(trip.ends_at) >= mStart && Date.parse(trip.ends_at) < dayStart)
        .reduce((sum, trip) => sum + tripNet(trip, state.data.settings.calculation), 0);
      const dayPlan = Math.max(0, (monthPlan - factBefore) / Math.max(1, remainingFromDay));
      const avgCheckDay = dayTrips.length ? (snap.netRevenue || 0) / dayTrips.length : 0;
      const lines = [`ОТЧЁТ ДНЯ ПО АВТОПАРКУ — ${fmtDayLong(dayIso)}`, '',
        `Парк в работе: ${fleet}`,
        `В рейсе: ${buckets.trip.length} (${pctOf(buckets.trip.length / (fleet || 1))})`,
        `Простой без причины: ${buckets.idle.length} — ${buckets.idle.map(v => v.plate).join(', ') || '—'}`,
        `Ремонт: ${buckets.repair.length} · Пересменка: ${buckets.shift.length}` +
          ` · Без водителя: ${buckets.no_driver.length} · Резерв: ${buckets.reserve.length}`,
        `КТГ ${pctOf(u.ktg)} · КВЛ ${pctOf(u.kvl)} · КИП ${pctOf(u.kip)}`,
        `Выручка без НДС (по выгрузкам дня): ${rub(snap.netRevenue || 0)} · рейсов завершено: ${dayTrips.length} · средний чек: ${rub(avgCheckDay)}`,
        `План дня: ${rub(dayPlan)} (остаток плана ${rub(monthPlan - factBefore)} на ${remainingFromDay} дн) — выполнение ${Math.round((snap.netRevenue || 0) / (dayPlan || 1) * 100)}%`,
        `Смена планирования: внесено заявок ${createdDay.length} на ${rub(createdSum)} (ср. чек ${rub(createdDay.length ? createdSum / createdDay.length : 0)}) · назначено рейсов: ${assignedDay}`,
        `Пробег: гружёный ${Math.round(snap.loadedKm || 0)} км · порожний ${Math.round(snap.emptyKm || 0)} км` +
          ` (${pctOf(snap.emptyRatio)}) · ремонтный ${Math.round(snap.repairKm || 0)} км`];
      box.dataset.text = lines.join('\n');
      box.innerHTML = `
        <div class="task-kpis five">
          <div class="task-kpi"><b>${fleet}</b><span>парк в работе</span></div>
          <div class="task-kpi"><b>${buckets.trip.length}</b><span>в рейсе · ${pctOf(buckets.trip.length / (fleet || 1))}</span></div>
          <div class="task-kpi ${buckets.idle.length ? 'warn' : ''}"><b>${buckets.idle.length}</b><span>простой без причины</span></div>
          <div class="task-kpi muted"><b>${buckets.repair.length + buckets.shift.length + buckets.no_driver.length + buckets.reserve.length}</b><span>недоступны</span></div>
          <div class="task-kpi ${((snap.netRevenue || 0) >= dayPlan) ? '' : 'warn'}"><b>${rub(snap.netRevenue || 0)}</b>
            <span>без НДС · план дня ${rub(dayPlan)} (${Math.round((snap.netRevenue || 0) / (dayPlan || 1) * 100)}%)</span></div>
        </div>
        <div class="task-balance-line ${createdDay.length ? 'ok' : 'bad'}">
          Смена планирования: внесено <b>${createdDay.length}</b> заявок на <b>${rub(createdSum)}</b>
          (ср. чек ${rub(createdDay.length ? createdSum / createdDay.length : 0)})
          · назначено рейсов: <b>${assignedDay}</b>
          · средний чек выгрузок: <b>${rub(avgCheckDay)}</b></div>
        <div class="task-balance-line ${(snap.emptyRatio || 0) > 0.3 ? 'bad' : 'ok'}">
          Пробег дня: гружёный <b>${Math.round(snap.loadedKm || 0)}</b> км · порожний
          <b>${Math.round(snap.emptyKm || 0)}</b> км (${pctOf(snap.emptyRatio)})
          · КТГ ${pctOf(u.ktg)} · КВЛ ${pctOf(u.kvl)} · КИП ${pctOf(u.kip)}</div>
        ${(snap.assignTrust?.accepted || snap.assignTrust?.overridden) ? (() => {
          const trust = snap.assignTrust;
          const total = trust.accepted + trust.overridden;
          return `<div class="task-balance-line ${trust.overridden > trust.accepted ? 'bad' : 'ok'}">
            Доверие автоподбору: принято <b>${trust.accepted}</b> из ${total}
            (${Math.round(trust.accepted / total * 100)}%) · заменено <b>${trust.overridden}</b></div>
          ${trust.overrides.length ? `<div class="task-sec"><b>Замены рекомендаций (причины логиста)</b>
            ${trust.overrides.slice(0, 10).map(item => `<div class="muted" style="margin:2px 0">
              ${escapeHtml(item.recommended)} → <b>${escapeHtml(item.assigned || '?')}</b>
              · ${escapeHtml(item.reason || 'без причины (до ввода правила)')}
              · <small>${escapeHtml((item.customer || '').slice(0, 26))}</small></div>`).join('')}</div>` : ''}`;
        })() : ''}
        ${snap.controlFreshness ? `<div class="task-balance-line ${snap.controlFreshness.realtimePct < 20 ? 'bad' : snap.controlFreshness.realtimePct < 50 ? '' : 'ok'}">
          Свежесть контроля: отметок <b>${snap.controlFreshness.marks}</b> ·
          в моменте (до 30 мин) <b>${snap.controlFreshness.realtimePct}%</b> ·
          медиана запаздывания <b>${snap.controlFreshness.medianH} ч</b>
          · от водителей через бот <b>${snap.controlFreshness.driverMarks}</b></div>` : ''}
        <div class="task-sec"><b>В рейсе (${buckets.trip.length})</b>${chipList(buckets.trip)}</div>
        <div class="task-sec"><b>⚠ Простой без причины (${buckets.idle.length})</b>${chipList(buckets.idle, idleSince)}</div>
        <div class="task-sec"><b>Ремонт (${buckets.repair.length})</b>${chipList(buckets.repair)}</div>
        <div class="task-sec"><b>Пересменка (${buckets.shift.length}) · Без водителя (${buckets.no_driver.length}) · Резерв (${buckets.reserve.length})</b>
          ${chipList([...buckets.shift, ...buckets.no_driver, ...buckets.reserve])}</div>
        <div class="task-sec" id="bossAttendance"><b>Явка водителей</b>
          <p class="muted" style="margin:4px 0 0">Загружаю…</p></div>`;
      // Явка за день — отдельным запросом (не входит в bootstrap).
      try {
        const att = await api(`/api/attendance?day=${dayIso}`);
        const sum = att.summary;
        const reasons = Object.entries(sum.byReason)
          .map(([key, count]) => `${att.reasons[key] || key}: ${count}`).join(' · ');
        document.getElementById('bossAttendance').innerHTML = `<b>Явка водителей</b>
          <div class="task-balance-line ${sum.unmarked ? 'bad' : 'ok'}" style="margin-top:4px">
            Вышло <b>${sum.present}</b> · невыход <b>${sum.absent}</b>${reasons ? ` (${reasons})` : ''}
            · не отмечено <b>${sum.unmarked}</b>
            · укомплектованность <b>${sum.staffing.toFixed(2)}</b> при нормативе ${sum.staffingTarget}
            ${sum.present + sum.absent === 0 ? ' — явка за день не велась (отмечает «Ресурс → Явка»)' : ''}</div>`;
      } catch { document.getElementById('bossAttendance').innerHTML = ''; }
    };
    context.showModal(`<h2 style="margin-bottom:6px">📆 Отчёт дня по автопарку</h2>
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px">
        ${dayPickerHtml('bossDailyDay', defaultDay, 'за')}
        <button class="button small" id="bossDailyCopy" style="margin-left:auto">📋 Скопировать</button>
      </div>
      <div id="bossDailyBody" style="max-height:62vh;overflow:auto"></div>`);
    const modal = document.querySelector('#modalRoot .modal');
    if (modal) modal.style.width = 'min(760px, 96vw)';
    renderDay(defaultDay);
    wireDayPicker(document, 'bossDailyDay', value => renderDay(value));
    document.getElementById('bossDailyCopy').onclick = async () => {
      const text = document.getElementById('bossDailyBody').dataset.text || '';
      try { await navigator.clipboard.writeText(text); } catch {
        const area = document.createElement('textarea');
        area.value = text; document.body.append(area);
        area.select(); document.execCommand('copy'); area.remove();
      }
      toast('Отчёт дня скопирован');
    };
  };

  // ── Обработчики ──
  const rerender = () => renderBoss(container, context);
  container.querySelector('#bossDaily').onclick = dailyDialog;
  container.querySelector('#bossDemurrage').onclick = () => demurrageDialog(context);
  container.querySelector('#bossReconcile').onclick = () => reconcileDialog(context);
  container.querySelector('#bossProject160').onclick = () => project160Dialog(context);
  container.querySelector('#bossShift').onclick = () => shiftDialog(context);
  container.querySelector('#bossDeliveryPlan').onclick = () => deliveryPlanDialog(context);
  container.querySelector('#bossShiftPlanner').onclick = () => shiftPlannerDialog(context);
  container.querySelector('#bossInventory').onclick = () => inventoryDialog(context, 'all');
  container.querySelector('#bossRingLoad').onclick = () => ringLoadDialog(context);
  container.querySelector('#bossSelfTuning').onclick = () => selfTuningDialog(context);
  container.querySelector('#bossParkReport').onclick = () => parkReportDialog(context);
  container.querySelector('#bossBrief').onclick = () => briefDialog(context);
  container.querySelector('#bossMileage').onclick = () => mileageDialog(context);
  wireBossTabs(container, context);
  container.querySelector('#bossViewOpsBack').onclick = () => {
    state.bossView = 'ops';
    rememberBossView('ops');
    renderBoss(container, context);
  };
  wireRangePicker(container, 'bossFrom', 'bossTo', (a, b) => {
    state.bossFrom = a;
    state.bossTo = b;
    rerender();
  });
  document.getElementById('bossPlan').onchange = async event => {
    const value = Math.max(0, Number(event.currentTarget.value) || 0);
    try {
      await api(`/api/revenue-plans/${planPeriod}`, { method: 'PUT', body: JSON.stringify({ targetNet: value }) });
      toast(value ? `План на ${periodLabel}: ${rub(value)}` : 'План выручки снят');
      await context.onReload();
      rerender();
    } catch (error) { toast(error.message, 'error'); }
  };
  document.getElementById('bossClose').onclick = async () => {
    if (!confirm(`Зафиксировать период «${periodLabel}» в истории?`)) return;
    try {
      await api(`/api/periods/${planPeriod}/close`, { method: 'POST', body: JSON.stringify({}) });
      toast(`Период «${periodLabel}» закрыт`);
    } catch (error) { toast(error.message, 'error'); }
  };
  document.getElementById('bossReport').onclick = () =>
    context.openReport(document.getElementById('bossReportKind').value, from, to);
  // Поиск по странице: фильтрует строки всех таблиц отчёта (итоги .tot остаются).
  const search = document.getElementById('bossSearch');
  search.oninput = () => {
    const needle = search.value.toLowerCase();
    container.querySelectorAll('.rtable tbody tr').forEach(row => {
      const keep = !needle || row.classList.contains('tot') ||
        row.textContent.toLowerCase().includes(needle);
      row.style.display = keep ? '' : 'none';
    });
  };
  // Подсветка активной секции в якорной навигации при прокрутке.
  const links = [...container.querySelectorAll('#brepNav a')];
  const sections = links.map(link => container.querySelector(link.getAttribute('href')));
  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      links.forEach(link => link.classList.remove('on'));
      const index = sections.indexOf(entry.target);
      if (index >= 0) links[index].classList.add('on');
    });
  }, { rootMargin: '-10% 0px -70% 0px' });
  sections.forEach(section => section && observer.observe(section));
}


// ── 🔧 Планировщик ремзоны (фундамент 09.09) ──
// Загрузка ремзоны по дням против живой нормы, заезды/выходы, грузовая
// база — и рекомендации перенести заезд из пикового дня в свободный.
// Заезды планируются как недоступности в карточке ТС; здесь — картина
// и подсказки, решение за человеком.
async function shiftPlannerDialog(context) {
  let plan;
  try { plan = await api('/api/shift-planner'); } catch (error) { toast(error.message, 'error'); return; }
  const WDS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
  const maxLoad = Math.max(plan.norm * 1.6, ...plan.days.map(day => day.load), 1);
  const rows = plan.days.map(day => {
    const wd = new Date(Date.parse(day.day)).getUTCDay();
    const ratio = day.load / plan.norm;
    const color = ratio > 1.5 ? 'var(--bad)' : ratio > 1 ? 'var(--warn)' : 'var(--ok)';
    const width = Math.round(day.load / maxLoad * 100);
    const shopList = day.inShop.map(item =>
      `${item.plate} (${item.kind === 'repair' ? 'ремонт' : 'пересменка'} до ${item.till.slice(8)}.${item.till.slice(5, 7)})`).join(', ');
    return `<tr${day.day === plan.todayIso ? ' style="background:color-mix(in srgb, var(--warn) 12%, transparent)"' : ''}>
      <td style="white-space:nowrap"><b>${day.day.slice(8)}.${day.day.slice(5, 7)}</b> <small class="muted">${WDS[wd]}</small></td>
      <td style="min-width:180px"><div title="${escapeHtml(shopList)}" style="background:${color};height:14px;border-radius:4px;width:${width}%;min-width:${day.load ? 22 : 0}px;color:#fff;font-size:10px;text-align:center;line-height:14px">${day.load || ''}</div></td>
      <td class="num">${day.starts.length ? `+${day.starts.length}` : ''}</td>
      <td class="num">${day.outs.length || ''}</td>
      <td class="num">${day.gridPlan || ''}</td>
      <td><small class="muted">${day.starts.map(item => item.plate).slice(0, 4).join(', ')}${day.starts.length > 4 ? '…' : ''}</small></td>
    </tr>`;
  }).join('');
  context.showModal(`<h2>🔧 Ремзона — 14 дней</h2>
    <p class="muted">Живая норма: <b>${plan.norm}</b> машин в день (средняя загрузка ремонтами и
      пересменками за 60 суток). Зелёный — в норме, жёлтый — выше нормы, красный — пик (>×1,5).
      Наведите на бар — список машин в ремзоне. Заезды планируются недоступностями в карточке ТС —
      планировщик подсказывает дни, решение за человеком.</p>
    <div class="bi-scroll" style="max-height:52vh"><table class="bi-table">
      <thead><tr><th>День</th><th>Загрузка ремзоны</th>
        <th class="num" title="Заездов в этот день">Заезд</th>
        <th class="num" title="Выходов в строй (окончания «без водителя», пересменок, ремонтов)">Выход</th>
        <th class="num" title="План сетки: рейсов из Дома в этот день недели">Грузы</th>
        <th>Кто заезжает</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    ${plan.suggestions.length ? `<div class="scolh" style="margin-top:8px">Рекомендации переносов <span>${plan.suggestions.length}</span></div>
      <div class="list">${plan.suggestions.map(item => `<div class="list-item">
        <span style="flex:1">🔧 <b>${escapeHtml(item.plate)}</b> (${item.kind === 'repair' ? 'ремонт' : 'пересменка'}):
          перенести заезд ${item.from.slice(8)}.${item.from.slice(5, 7)} → <b>${item.to.slice(8)}.${item.to.slice(5, 7)}</b>
          <small class="muted" style="display:block">${escapeHtml(item.reason)}</small></span>
      </div>`).join('')}</div>`
    : '<p class="muted" style="margin-top:8px">Пиков нет — нагрузка ремзоны ровная, переносы не нужны.</p>'}
    <div class="modal-actions"><button type="button" class="button ghost" data-close>Закрыть</button></div>`, 'wide');
}

// «🛣 Пробеги за период» (заказ руководителя 20.10): общий / гружёный /
// порожний, среднесуточный против цели (настройка dailyKmTarget, 500).
// Период до минуты; источники в порядке доверия: одометр CAN на границах
// периода → GPS-трек → дневной кэш (помечается по каждой машине).
// «⚡ Сводка периода» (заказ руководителя 26.10): короткий отчёт для
// коротких совещаний — только главные цифры и кнопка «скопировать текст».
function briefDialog(context) {
  const today = new Date();
  const first = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const yest = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  context.showModal(`<h2>⚡ Сводка периода</h2>
    <div style="display:flex;gap:8px;align-items:end;flex-wrap:wrap">
      <label class="field">С (с 00:00)<input type="date" id="briefFrom" value="${first}"></label>
      <label class="field">По (включительно)<input type="date" id="briefTo" value="${yest}"></label>
      <label class="field">Сравнивать с
        <select id="briefBase">
          <option value="prev">предыдущим периодом (встык)</option>
          <option value="month">тем же отрезком прошлого месяца</option>
        </select></label>
      <button class="button small" id="briefGo">Сформировать</button>
    </div>
    <div id="briefBody" style="margin-top:10px"></div>
    <div class="modal-actions"><button type="button" class="button ghost" data-close>Закрыть</button></div>`, 'narrow');
  const run = async () => {
    const from = document.getElementById('briefFrom').value;
    const to = document.getElementById('briefTo').value;
    const box = document.getElementById('briefBody');
    box.innerHTML = '<p class="muted">Формируем…</p>';
    let r;
    const baseKind = document.getElementById('briefBase').value;
    try { r = await api(`/api/brief-report?from=${from}&to=${to}&base=${baseKind}`); }
    catch (error) { box.innerHTML = `<p class="muted">${escapeHtml(error.message)}</p>`; return; }
    const fd = value => `${String(value).slice(8, 10)}.${String(value).slice(5, 7)}`;
    // Номер календарной недели (ISO): одна — «нед. 44», диапазон — «нед. 41–44».
    const isoWeek = iso => {
      const d = new Date(Date.parse(iso + 'T00:00:00Z'));
      const day = (d.getUTCDay() + 6) % 7;
      d.setUTCDate(d.getUTCDate() - day + 3);
      const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
      const fday = (firstThu.getUTCDay() + 6) % 7;
      firstThu.setUTCDate(firstThu.getUTCDate() - fday + 3);
      return 1 + Math.round((d - firstThu) / (7 * 86_400_000));
    };
    const w1 = isoWeek(r.from);
    const w2 = isoWeek(r.to);
    const weekLabel = w1 === w2 ? `нед. ${w1}` : `нед. ${w1}–${w2}`;
    // Динамика к предыдущему периоду той же длины (встык): ▲/▼ в процентах.
    const delta = (curVal, prevVal, goodUp = true) => {
      if (!Number.isFinite(curVal) || !Number.isFinite(prevVal) || !prevVal) return '';
      const pct = (curVal - prevVal) / prevVal * 100;
      if (Math.abs(pct) < 0.5) return ' · =';
      const arrow = pct > 0 ? '▲' : '▼';
      return ` · ${arrow}${Math.abs(pct).toFixed(Math.abs(pct) >= 10 ? 0 : 1)}%`;
    };
    const p = r.prev || {};
    const latePct = r.lateFacts ? Math.round(r.lateUnload / r.lateFacts * 100) : null;
    const prevLatePct = p.lateFacts ? p.lateUnload / p.lateFacts * 100 : null;
    const lines = [
      `Период ${fd(r.from)}–${fd(r.to)} (${r.days} сут · ${weekLabel})`,
      `На линии: ${r.onLineAvg} ТС/сут в среднем (парк ${r.fleet})${delta(r.onLineAvg, p.onLineAvg)}`,
      `Выполнено заказов: ${r.orders}${delta(r.orders, p.orders)}`,
      r.km != null ? `Пройдено: ${r.km.toLocaleString('ru-RU')} км (гружёный ${r.loadedPct}%)${delta(r.km, p.km)}` : null,
      r.kmPerDayPerVehicle != null ? `Темп пробега: ${r.kmPerDayPerVehicle} км/сут на ТС (цель ${r.kmTarget})${delta(r.kmPerDayPerVehicle, p.kmPerDayPerVehicle)}` : null,
      `Опозданий на выгрузку: ${r.lateUnload} из ${r.lateFacts}${latePct != null ? ` (${latePct}%)` : ''}${delta(latePct, prevLatePct, false)}`,
      r.planNet ? `Выручка б/НДС: план ${rub(r.planNet)} · факт ${rub(r.factNet)} · ${r.planPct}%${delta(r.factNet, p.factNet)}`
        : `Выручка б/НДС: факт ${rub(r.factNet)} (план на период не задан)${delta(r.factNet, p.factNet)}`,
      r.planPerDay ? `Темп на парк: план ${rub(r.planPerDay)}/сут · факт ${rub(r.factPerDay)}/сут${delta(r.factPerDay, p.factPerDay)}`
        : `Темп на парк: факт ${rub(r.factPerDay)}/сут${delta(r.factPerDay, p.factPerDay)}`,
      `Средний чек: ${rub(r.avgCheck)}${delta(r.avgCheck, p.avgCheck)}`,
      // Э4 затрат (03.11): блок приходит с сервера только обладателю
      // персонального доступа к затратам — у остальных строк просто нет.
      r.expenses?.count ? `Затраты (журнал, б/НДС): ${rub(r.expenses.totalNet)}` +
        `${delta(r.expenses.totalNet, r.prevExpenses?.totalNet, false)} — ` +
        r.expenses.byKind.map(k => `${k.key === 'variable' ? 'перем.' : 'пост.'} ${rub(k.net)}`).join(' · ') : null,
      // ЦФО (блок 3 «Слияния», 07.11): та же сумма по центрам ответственности.
      r.expenses?.byCfo?.length ? `По ЦФО: ${r.expenses.byCfo.map(k =>
        `${({ drv: 'эксплуатация', toir: 'ТОиР', log: 'логистика', staff: 'направление' })[k.key] || k.key} ${rub(k.net)}`).join(' · ')}` : null,
      r.expenses?.top?.length ? `Топ статей: ${r.expenses.top.slice(0, 4)
        .map(item => `${item.name} ${rub(item.net)}`).join(' · ')}` : null,
      r.expenses?.count ? `Прибыль по учтённому: ${rub(r.factNet - r.expenses.totalNet)}` +
        ` (выручка − затраты журнала; статьи вне журнала — пока нормативы калькуляции)` : null,
      `Потери парка: ремонт ${r.repairMd} м-д · без водителя ${r.noDriverMd} м-д${delta(r.repairMd + r.noDriverMd, (p.repairMd || 0) + (p.noDriverMd || 0), false)}`,
      // Э3 внештаток: строка появляется, только когда есть что сказать.
      r.incidents && (r.incidents.counts.act || r.incidents.counts.return || r.incidents.openReturns.length)
        ? `Внештатки: актов ${r.incidents.counts.act} · возвратов ${r.incidents.counts.return}` +
          `${r.incidents.returnsClosed ? ` (закрыто ${r.incidents.returnsClosed})` : ''}` +
          `${r.incidents.openReturns.length ? ` · в работе ${r.incidents.openReturns.length}, старший ${Math.ceil(r.incidents.openReturns[0].age_days)} дн` : ''}`
        : null,
      `Динамика ▲▼ — ${r.base === 'month' ? 'к тому же отрезку прошлого месяца' : 'к предыдущему периоду той же длины'} (${fd(r.prevFrom)}–${fd(r.prevTo)})`
    ].filter(Boolean);
    box.innerHTML = `<div class="brief-lines">${lines.map(line =>
      `<div class="brief-line">${escapeHtml(line)}</div>`).join('')}</div>
      <div style="display:flex;gap:6px;margin-top:8px">
        <button class="button small" id="briefCopy">📋 Скопировать текст</button>
        <button class="button small" id="briefPrint"
          title="Печатная форма со строками сводки и графиками по дням — в диалоге печати выберите «Сохранить как PDF»">🖨 Печать (PDF)</button>
        <button class="button small" id="briefDeck"
          title="Презентация для совещания: восемь альбомных страниц — титул, ключевые цифры, КТГ/КВЛ/КИП, выручка и темп, на линии, пробег по неделям, опоздания, итог. База — те же числа прошлого месяца. Скачивается готовым PDF-файлом">📑 Презентация (PDF)</button>
      </div>`;
    document.getElementById('briefCopy').onclick = async () => {
      try {
        await navigator.clipboard.writeText(lines.join('\n'));
        toast('Сводка скопирована');
      } catch { toast('Не удалось скопировать', 'error'); }
    };
    // 📑 Презентация (03.11): готовый PDF с сервера — скачивание ссылкой,
    // всплывающие окна не нужны.
    document.getElementById('briefDeck').onclick = () => {
      const link = document.createElement('a');
      link.href = `/api/brief-deck.pdf?from=${r.from}&to=${r.to}`;
      link.download = `Сводка_периода_${r.from}_${r.to}.pdf`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      toast('Презентация формируется — файл сейчас скачается');
    };
    // 🖨 Печатная форма (заказ руководителя 03.11): строки сводки +
    // графики по дням (выручка/план, на линии, пробег) — печать
    // браузером, в диалоге «Сохранить как PDF».
    document.getElementById('briefPrint').onclick = () => {
      const s = r.series || { days: [], net: [], km: [], online: [] };
      const W = 980, H = 200, PL = 56, PR = 12, PT = 14, PB = 26;
      const plotW = W - PL - PR, plotH = H - PT - PB;
      const esc = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
      const chart = (title, values, { plan = null, kind = 'bar', unit = v => v } = {}) => {
        if (!values.length || !values.some(v => v > 0)) return '';
        const max = Math.max(...values, plan || 0) * 1.08 || 1;
        const x = i => PL + plotW * i / Math.max(1, values.length - (kind === 'line' ? 1 : 0));
        const barW = Math.max(2, plotW / values.length - 2);
        let grid = '';
        for (let g = 1; g <= 4; g += 1) {
          const yy = H - PB - plotH * g / 4;
          grid += `<line x1="${PL}" y1="${yy}" x2="${W - PR}" y2="${yy}" stroke="#ddd" stroke-width="1"/>`
            + `<text x="${PL - 6}" y="${yy + 4}" text-anchor="end" font-size="10" fill="#777">${esc(unit(max * g / 4))}</text>`;
        }
        // Подписи дат: первая, последняя и каждая ~седьмая.
        let labels = '';
        const step = Math.max(1, Math.round(values.length / 10));
        s.days.forEach((day, i) => {
          if (i % step && i !== values.length - 1) return;
          labels += `<text x="${x(i) + (kind === 'bar' ? barW / 2 : 0)}" y="${H - 8}" text-anchor="middle" font-size="10" fill="#777">${day.slice(8, 10)}.${day.slice(5, 7)}</text>`;
        });
        const body = kind === 'line'
          ? `<polyline fill="none" stroke="#1f6f54" stroke-width="2" points="${values.map((v, i) =>
            `${x(i).toFixed(1)},${(H - PB - plotH * v / max).toFixed(1)}`).join(' ')}"/>`
          : values.map((v, i) => `<rect x="${x(i).toFixed(1)}" y="${(H - PB - plotH * v / max).toFixed(1)}"
              width="${barW.toFixed(1)}" height="${(plotH * v / max).toFixed(1)}" fill="#2b3a47"/>`).join('');
        const planLine = plan ? `<line x1="${PL}" y1="${(H - PB - plotH * plan / max).toFixed(1)}"
            x2="${W - PR}" y2="${(H - PB - plotH * plan / max).toFixed(1)}"
            stroke="#8f2f24" stroke-width="1.5" stroke-dasharray="6 4"/>` : '';
        return `<h3>${esc(title)}</h3>
          <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto">${grid}${body}${planLine}${labels}</svg>`;
      };
      const t = v => `${Math.round(v / 1000)} т₽`;
      const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8">
        <title>Сводка периода ${fd(r.from)}–${fd(r.to)}</title>
        <style>
          body { font: 13px/1.45 Arial, sans-serif; color: #1c242c; margin: 28px; }
          h1 { font-size: 20px; margin: 0 0 2px; } h3 { font-size: 13px; margin: 14px 0 4px; }
          .sub { color: #777; margin-bottom: 12px; }
          .line { padding: 2px 0; border-bottom: 1px solid #eee; }
          .foot { color: #999; font-size: 11px; margin-top: 16px; }
          @media print { body { margin: 10mm; } }
        </style></head><body>
        <h1>⚡ Сводка периода ${fd(r.from)} – ${fd(r.to)}</h1>
        <div class="sub">Пегас-Авто · Планер · сформировано ${new Date().toLocaleString('ru-RU')}</div>
        ${lines.map(line => `<div class="line">${esc(line)}</div>`).join('')}
        ${chart(`Выручка по дням, т₽ без НДС${r.planPerDay ? ' (пунктир — план в день)' : ''}`,
    s.net, { plan: r.planPerDay, unit: t })}
        ${chart('На линии, ТС по дням', s.online, { kind: 'line', unit: v => Math.round(v) })}
        ${chart('Пробег парка по дням, тыс. км', s.km, { unit: v => (v / 1000).toFixed(0) })}
        <div class="foot">Цифры — из канона отчётности планера; графики по дням периода.
          Полный отчёт эксплуатации: /ops-report.</div>
      </body></html>`;
      const w = window.open('', '_blank');
      if (!w) { toast('Браузер заблокировал окно печати — разрешите всплывающие окна', 'error'); return; }
      w.document.write(html);
      w.document.close();
      setTimeout(() => { try { w.focus(); w.print(); } catch { /* окно закрыли */ } }, 400);
    };
  };
  document.getElementById('briefGo').onclick = run;
  document.getElementById('briefBase').onchange = run;
  run();
}

export async function mileageDialog(context) {
  const { showModal } = context;
  const now = new Date();
  const toLocal = date => new Date(date.getTime() - date.getTimezoneOffset() * 60000)
    .toISOString().slice(0, 16);
  const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
  showModal(`<form id="mileForm"><h2>🛣 Пробеги парка за период</h2>
    <p class="muted">Общий / гружёный / порожний и среднесуточный на машину против цели.
      Конструкция: ежедневные снимки одометра CAN на 00:00 — отчёт считает РАЗНОСТЬ
      показаний на границах (мгновенно и стабильно, точность по суткам); пробелы
      журнала добираются дневным кэшем, машины без CAN — по координатам плеч рейсов.</p>
    <div class="form-grid">
      <label class="field">С (с 00:00)<input type="date" name="from"
        value="${toLocal(dayStart).slice(0, 10)}" required></label>
      <label class="field">По (включительно)<input type="date" name="to"
        value="${toLocal(now).slice(0, 10)}" required></label>
    </div>
    <div class="modal-actions">
      <button type="button" class="button ghost" data-close>Отмена</button>
      <button class="button">Сформировать</button>
    </div>
    <p class="muted" id="mileWait" style="display:none">Формируем из журнала одометров…</p>
  </form>`, 'wide');
  document.getElementById('mileForm').onsubmit = async event => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    const fromIso = values.from;
    const toIso = values.to;
    document.getElementById('mileWait').style.display = '';
    let data;
    try { data = await api(`/api/mileage-report?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`); }
    catch (error) { toast(error.message, 'error'); document.getElementById('mileWait').style.display = 'none'; return; }
    renderMileage(context, data);
  };
}

function renderMileage(context, d) {
  const fmtDT = iso => new Date(iso + (String(iso).length === 10 ? 'T00:00:00' : '')).toLocaleDateString('ru-RU',
    { day: '2-digit', month: '2-digit' });
  const km = value => `${Math.round(value).toLocaleString('ru-RU')} км`;
  const okTarget = d.perDayPerVehicle >= d.target;
  const srcLine = Object.entries(d.sources).filter(([, n]) => n > 0)
    .map(([s, n]) => `${s}: ${n}`).join(' · ');
  const rows = d.perVehicle.map(v => `<tr${v.perDay < d.target && v.km > 0 ? ' class="warn-row"' : ''}>
      <td class="mono">${escapeHtml(v.plate)}</td>
      <td class="num">${v.km.toLocaleString('ru-RU')}</td>
      <td class="num">${v.loaded.toLocaleString('ru-RU')}</td>
      <td class="num">${v.empty.toLocaleString('ru-RU')}</td>
      <td class="num"><b>${v.perDay.toLocaleString('ru-RU')}</b></td>
      <td>${escapeHtml(v.source)}</td>
    </tr>`).join('');
  context.showModal(`<h2>🛣 Пробеги · ${fmtDT(d.from)} — ${fmtDT(d.to)}
      <small class="muted">(${d.days.toFixed(2)} сут · парк ${d.fleet})</small></h2>
    <div class="bi-kpis boss-modal-kpis">
      <div class="metric"><span class="l">Общий</span><span class="v">${km(d.totalKm)}</span></div>
      <div class="metric"><span class="l">Гружёный</span><span class="v">${km(d.loadedKm)}</span>
        <span class="d">${d.totalKm ? Math.round(d.loadedKm / d.totalKm * 100) : 0}%</span></div>
      <div class="metric"><span class="l">Порожний</span><span class="v">${km(d.emptyKm)}</span>
        <span class="d">${d.totalKm ? Math.round(d.emptyKm / d.totalKm * 100) : 0}%</span></div>
      <div class="metric ${okTarget ? 'pos' : 'neg'}"><span class="l">Среднесуточный на машину</span>
        <span class="v">${d.perDayPerVehicle}<small>км/сут</small></span>
        <span class="d">цель ${d.target}</span></div>
    </div>
    <p class="muted">Источники данных по маш.: ${srcLine}. «Гружёный» — честные км рейсов
      (убытие с погрузки → выгрузка, CAN), частично попавшие рейсы — долей времени;
      порожний = общий − гружёный.</p>
    <div class="bi-scroll" style="max-height:55vh"><table class="bi-table rtable">
      <thead><tr><th>Борт</th><th class="num">Общий, км</th><th class="num">Гружёный</th>
        <th class="num">Порожний</th><th class="num">км/сут</th><th>Источник</th></tr></thead>
      <tbody>${rows || '<tr><td colspan=6>нет данных</td></tr>'}</tbody></table></div>
    <div class="modal-actions">
      <button type="button" class="button ghost" data-close>Закрыть</button>
      <button type="button" class="button" onclick="window.print()">Печать</button>
    </div>`, 'wide');
}
