// Блок руководителя — операционный отчёт АТП (по образцу отчёта
// «Пегас-Авто» за период): секции с якорной навигацией, KPI-полоса
// с планами и отклонениями, каскад-воронка КТГ→КВЛ→КИП с потерями по
// владельцам, баланс машино-дней, экономика по типам ТС и топ клиентов.
// Тема «панель приборов» (спидометры, лобовое стекло) выведена из продукта.
// Данные — GET /api/reports (сервер) + рейсы bootstrap для кривой и клиентов.
import { inventoryDialog } from './inventory.js';
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
const PLAN = { ktg: 0.97, kvl: 0.99, kip: 0.99 };
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
const tripNet = (trip, calc) => trip.revenue_vat / (1 + (trip.cash ? 0 : /(?<![\p{L}\p{N}])ИП(?![\p{L}\p{N}])/iu.test(trip.customer_name)
  ? Number(calc.individualEntrepreneurVatRate ?? 0.07) : Number(calc.vatRate ?? 0.22)));

export async function renderBoss(container, context) {
  const { state } = context;
  const monthIso = state.month.toISOString().slice(0, 10);
  const nextMonth = new Date(Date.UTC(state.month.getUTCFullYear(), state.month.getUTCMonth() + 1, 1));
  const from = state.bossFrom || monthIso;
  const to = state.bossTo || nextMonth.toISOString().slice(0, 10);
  let report;
  try {
    report = await api(`/api/reports?from=${from}&to=${to}`);
  } catch (error) {
    container.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    return;
  }
  const u = report.utilization;
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
      g: revenuePlan ? report.netRevenue / revenuePlan : 0, c: 'var(--ok)' },
    { k: 'КТГ — техготовность', v: pct(u.ktg), p: 'план 97%',
      pill: `${devPP(u.ktg, PLAN.ktg) >= 0 ? '+' : ''}${devPP(u.ktg, PLAN.ktg).toFixed(1)} п.п.`,
      pc: pillCls(devPP(u.ktg, PLAN.ktg)), g: u.ktg / PLAN.ktg, c: 'var(--warn)' },
    { k: 'КВЛ — выпуск на линию', v: pct(u.kvl), p: 'план 99%',
      pill: `${devPP(u.kvl, PLAN.kvl) >= 0 ? '+' : ''}${devPP(u.kvl, PLAN.kvl).toFixed(1)} п.п.`,
      pc: pillCls(devPP(u.kvl, PLAN.kvl)), g: u.kvl / PLAN.kvl, c: 'var(--teal)' },
    { k: 'КИП — использование', v: pct(u.kip), p: `в работе ${n1(u.workDays / Math.max(1, u.days))} ед. из ${u.vehicles}`,
      pill: `${devPP(u.kip, PLAN.kip) >= 0 ? '+' : ''}${devPP(u.kip, PLAN.kip).toFixed(1)} п.п.`,
      pc: pillCls(devPP(u.kip, PLAN.kip)), g: u.kip / PLAN.kip, c: '#7a6fb0' },
    { k: 'Использование фонда', v: pct(fondUse), p: `${n0(u.workDays)} из ${n0(u.calendarDays)} машино-дней`,
      pill: `${devPP(fondUse, u.utilizationTarget) >= 0 ? '+' : ''}${devPP(fondUse, u.utilizationTarget).toFixed(1)} п.п.`,
      pc: pillCls(devPP(fondUse, u.utilizationTarget)), g: u.utilizationTarget ? fondUse / u.utilizationTarget : 0, c: '#5e87ad' }
  ];
  const kpiHtml = kpiCells.map(x => `<div>
    <div class="k">${x.k}</div>
    <div class="v ${x.pc === 'g' ? 'good' : x.pc === 'w' ? 'warn' : 'bad'}">${x.v}</div>
    <div class="p">${x.p}${x.pill ? `<span class="brep-pill ${x.pc}">${x.pill}</span>` : ''}</div>
    <div class="gauge"><i style="width:${Math.min(x.g * 100, 100)}%;background:${x.c}"></i></div>
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
  const done = revenuePlan ? report.netRevenue / revenuePlan : 0;
  const gap = revenuePlan ? report.netRevenue - revenuePlan : 0;
  const periodSection = `<section id="brep-s1">
    <div class="brep-shead"><span class="idx">01</span><h3>Отчётный период</h3>
      <span class="note">${fmtDay(from)} – ${fmtDay(to)} · ${u.periodDays || u.days} дн${u.futureDays
        ? ` · учтено ${u.days} (будущие ${u.futureDays} в машино-дни не входят)` : ''} · выручка по дате выгрузки</span></div>
    <div class="rcard">
      <div class="brep-mrow">
        <div><div class="k">План без НДС</div><div class="v">${revenuePlan ? mln(revenuePlan) : '—'}</div>
          <div class="p">${revenuePlan ? `${rub(revenuePlan / dayCount)}/сут` : 'задайте в консоли'}</div></div>
        <div><div class="k">Забито без НДС</div><div class="v">${mln(report.netRevenue)}</div>
          <div class="p">выгружено ${mln(report.netRevenueDone || 0)} · ${rub(report.netRevenue / Math.max(1, u.periodDays || u.days))}/сут</div></div>
        <div><div class="k">Выполнение</div><div class="v ${done >= 1 ? 'good' : done >= 0.9 ? 'warn' : 'bad'}">${revenuePlan ? pct(done) : '—'}</div>
          <div class="p">${revenuePlan ? `${planDev >= 0 ? '+' : ''}${planDev.toFixed(1)}% к плану` : ''}</div></div>
        <div><div class="k">${gap >= 0 ? 'Запас' : 'Разрыв'}</div><div class="v ${gap >= 0 ? 'good' : 'bad'}">${revenuePlan ? mln(Math.abs(gap)) : '—'}</div>
          <div class="p">${revenuePlan ? `${rub(Math.abs(gap) / Math.max(1, u.days))}/сут` : ''}</div></div>
      </div>
      ${revenuePlan ? `<div class="brep-pbar"><i style="width:${Math.min(100, done * 100).toFixed(1)}%"></i><em>план 100%</em></div>` : ''}
      <div class="brep-ctitle" style="margin-top:14px">Выручка нарастающим итогом</div>
      <div class="brep-csub">без НДС, по дате выполнения${revenuePlan ? ' · пунктир — план равномерно по дням' : ''}</div>
      ${cumChart(cumFact, cumPlan, dayLabels)}
      <table class="rtable" style="margin-top:10px"><tbody>
        <tr><td>Рейсов завершено в периоде</td><td class="num">${report.trips}</td>
          <td>Средний чек без НДС</td><td class="num">${report.trips ? rub(report.netRevenue / report.trips) : '—'}</td></tr>
        <tr><td>Сцепок в работе (среднее)</td><td class="num">${n1(u.workDays / Math.max(1, u.days))}</td>
          <td>Выручка на сцепку в сутки</td><td class="num">${u.workDays ? rub(report.netRevenue / u.workDays) : '—'}</td></tr>
      </tbody></table>
    </div>
  </section>`;

  // ── 02 Каскад КТГ → КВЛ → КИП ──
  const perDay = value => value / Math.max(1, u.days);
  const steps = [
    { n: 'Списочный парк', v: u.vehicles, loss: null, c: '#54626F' },
    { n: 'Технически исправны', v: perDay(u.techDays), loss: u.vehicles - perDay(u.techDays),
      c: 'var(--warn)', own: 'ТОиР', kn: 'КТГ', k: u.ktg, pl: PLAN.ktg },
    { n: 'Выпущены на линию', v: perDay(u.lineDays), loss: perDay(u.techDays) - perDay(u.lineDays),
      c: 'var(--teal)', own: 'Водители', kn: 'КВЛ', k: u.kvl, pl: PLAN.kvl },
    { n: 'В работе', v: perDay(u.workDays), loss: perDay(u.lineDays) - perDay(u.workDays),
      c: '#7a6fb0', own: 'Логистика', kn: 'КИП', k: u.kip, pl: PLAN.kip }
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
        ? `${s.kn} <b>${pct(s.k)}</b> · план ${pct(s.pl, 0)} <span class="brep-pill ${pillCls(d)}">${d >= 0 ? '+' : ''}${d.toFixed(1)}</span>`
        : `база каскада · ${pct(perDay(u.workDays) / u.vehicles)} парка доходит до работы`}</span>
        <span>${s.own ? `${s.own} <b class="bad">−${n1(s.loss)}</b>` : ''}</span></div>
    </div>`;
  }).join('');
  const lossRows = [
    ['ТОиР', u.vehicles - perDay(u.techDays), 'var(--warn)'],
    ['Водители', perDay(u.techDays) - perDay(u.lineDays), 'var(--teal)'],
    ['Логистика', perDay(u.lineDays) - perDay(u.workDays), '#7a6fb0']
  ];
  const lossSum = lossRows.reduce((sum, row) => sum + row[1], 0);
  const cascadeSection = `<section id="brep-s2">
    <div class="brep-shead"><span class="idx">02</span><h3>Каскад КТГ → КВЛ → КИП</h3>
      <span class="note">среднесуточные единицы парка · потери по владельцам процессов</span></div>
    <div class="brep-casc">
      <div class="rcard">${cascadeHtml}</div>
      <div class="rcard"><div class="brep-ctitle">Куда уходит парк</div>
        <div class="brep-csub">простой ${n1(lossSum)} ед./сут в среднем за период</div>
        <table class="rtable"><thead><tr><th>Владелец</th><th class="num">Ед./сут</th><th class="num">Маш-дней</th><th class="num">Доля</th></tr></thead><tbody>
        ${lossRows.map(([name, value, color]) => `<tr>
          <td><span class="dotc" style="background:${color}"></span>${name}</td>
          <td class="num">${n1(value)}</td>
          <td class="num">${n0(value * u.days)}</td>
          <td class="num">${lossSum ? Math.round(value / lossSum * 100) : 0}%</td></tr>`).join('')}
        <tr class="tot"><td>Итого простой</td><td class="num">${n1(lossSum)}</td>
          <td class="num">${n0(lossSum * u.days)}</td><td class="num">100%</td></tr>
        </tbody></table>
        <p class="brep-hint">Рейсов за период ${report.trips} · ${n1(report.trips / Math.max(1, u.days))} в сутки
          · ${u.workDays ? n1(report.trips / u.workDays) : '—'} на работающую сцепку.</p>
      </div>
    </div>
  </section>`;

  // ── 03 Машино-дни: баланс календарного фонда ──
  const fondParts = [
    { n: 'В работе', v: md.work, c: '#7a6fb0', own: '—' },
    { n: 'Без заказа', v: md.idle, c: '#8a7fb3', own: 'логистика' },
    { n: 'Без водителя', v: md.noDriver, c: 'var(--teal)', own: 'водители' },
    { n: 'Пересменка', v: md.shift, c: '#5e87ad', own: 'водители' },
    { n: 'Ремонт', v: md.repair, c: 'var(--warn)', own: 'ТОиР' },
    { n: 'Выведены', v: md.out, c: '#8f9aa6', own: '—' }
  ].filter(part => part.v > 0);
  const stackHtml = fondParts.map(part =>
    `<div style="width:${(part.v / u.calendarDays * 100).toFixed(2)}%;background:${part.c}"
      title="${part.n}: ${n0(part.v)} м-дн">${part.v / u.calendarDays > 0.045 ? pct(part.v / u.calendarDays, 1) : ''}</div>`).join('');
  const lostVsNorm = Math.max(0, u.normDays - u.workDays);
  const mdSection = `<section id="brep-s3">
    <div class="brep-shead"><span class="idx">03</span><h3>Машино-дни</h3>
      <span class="note">${u.vehicles} сцепок × ${u.days} дн = ${n0(u.calendarDays)} машино-дней · норма ${pct(u.utilizationTarget, 1)}</span></div>
    <div class="rcard">
      <div class="brep-stack">${stackHtml}</div>
      <div class="brep-slegend">${fondParts.map(part =>
        `<span><span class="dotc" style="background:${part.c}"></span>${part.n} — ${n0(part.v)} м-дн</span>`).join('')}</div>
      <table class="rtable" style="margin-top:12px"><thead><tr><th>Статья</th><th>Владелец</th>
        <th class="num">Маш-дней</th><th class="num">Доля фонда</th><th class="num">Ед./сут</th></tr></thead><tbody>
        ${fondParts.map(part => `<tr><td><span class="dotc" style="background:${part.c}"></span>${part.n}</td>
          <td class="muted">${part.own}</td><td class="num">${n0(part.v)}</td>
          <td class="num">${pct(part.v / u.calendarDays)}</td>
          <td class="num">${n1(part.v / Math.max(1, u.days))}</td></tr>`).join('')}
        <tr class="tot"><td>Календарный фонд</td><td>—</td><td class="num">${n0(u.calendarDays)}</td>
          <td class="num">100%</td><td class="num">${n1(u.vehicles)}</td></tr>
      </tbody></table>
      <p class="brep-hint">Потеря против нормы — <b>${n0(lostVsNorm)}</b> машино-дней
        (${n1(lostVsNorm / Math.max(1, u.days))} сцепки в сутки). По марж. доходу
        ${rub(u.marginPerTripDay)} за машино-день это <b>${mln(u.lostProfit)} ₽</b> упущенного дохода за период.</p>
    </div>
  </section>`;

  // ── 04 Экономика ──
  const types = [...report.byVehicleType].sort((a, b) => b.netRevenue - a.netRevenue);
  const maxPerDay = Math.max(1, ...types.map(t => t.netRevenue / Math.max(1, u.days)));
  const ecoSection = `<section id="brep-s4">
    <div class="brep-shead"><span class="idx">04</span><h3>Экономика</h3>
      <span class="note">выручка без НДС · переменные и постоянные по нормативам настроек</span></div>
    <div class="brep-casc">
      <div class="rcard"><div class="brep-ctitle">Операционная прибыль · P&L</div>
        <div class="mdrow"><span>Выручка без НДС</span><b>${rub(report.netRevenue)}</b></div>
        <div class="mdrow"><span>− Переменные (путевые, страх./дороги, водитель, ХОУ)</span><b>${rub(report.netRevenue - report.contribution)}</b></div>
        <div class="mdrow"><span>= Маржинальный доход</span><b>${rub(report.contribution)}</b></div>
        <div class="mdrow"><span>− Постоянные (лизинг + накладные · ${u.vehicles}×${u.days} маш-дней)</span><b>${rub(report.fixed)}</b></div>
        <div class="mdrow big"><span>= Операционная прибыль</span><b class="${report.operationalProfit < 0 ? 'neg' : ''}">${rub(report.operationalProfit)}</b></div>
        <div class="mdrow"><span>Операционная маржа</span><b>${pct(report.operationalMargin)}</b></div>
        <div class="mdrow"><span>Марж. доход на машино-день</span><b>${rub(u.marginPerTripDay)}</b></div>
      </div>
      <div class="rcard"><div class="brep-ctitle">По типам ТС</div>
        <div class="brep-csub">полоса — выручка в сутки</div>
        <table class="rtable"><thead><tr><th>Тип</th><th class="num">Рейсов</th>
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
  const clientsSection = `<section id="brep-s5">
    <div class="brep-shead"><span class="idx">05</span><h3>Топ-10 клиентов</h3>
      <span class="note">${clients.length} заказчиков за период · топ-10 дают ${pct(topShare, 0)} выручки</span></div>
    <div class="rcard">
      <table class="rtable"><thead><tr><th>Заказчик</th><th class="num">Рейсов</th>
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
  container.innerHTML = `<div class="bosswrap brep">
    <div class="brep-title"><h2>PegasLogistic · операционный отчёт</h2>
      <span class="muted">${fmtDay(from)} – ${fmtDay(to)} · ${u.days} дн · парк ${u.vehicles} сцепок
        · НДС 22%, ИП 7% · рейс по дате выгрузки</span></div>
    <div class="brep-top">
      <div class="console">
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
          <option value="util">Использование парка</option>
          <option value="econ">Экономика по типам ТС</option><option value="clients">Экономика по клиентам</option>
          <option value="rejected">Отклонённые рейсы</option>
          <option value="execution">Контроль выполнения рейсов</option>
          <option value="vehicles">Аналитика по сцепкам</option>
          <option value="conflicts">История конфликтов</option>
          <option value="rejected-orders">Реестр заявок (подтверждённые/отклонённые)</option>
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
        <button class="button ghost small" id="bossInventory"
          title="Инвентаризация всех процессов: ресурс (дубли прицепов, забытые машины, висящие рейсы, дыры по водителям) + заявки с ошибочными датами, застрявшие стадии, дыры адресов">🧾 Инвентаризация</button>
        <button class="button ghost small" id="bossParkReport"
          title="Отчёт эксплуатации автопарка из выгрузок 1С (Заказы/Путевые листы/Ремонты): каскад по ЧАСАМ под грузом, разбор причин, честные сценарии">🏭 Эксплуатация (1С)</button>
      </div>
      <nav class="brep-nav" id="brepNav">
        <a href="#brep-s1" class="on">01 Период</a><a href="#brep-s2">02 Каскад</a>
        <a href="#brep-s3">03 Машино-дни</a><a href="#brep-s4">04 Экономика</a>
        <a href="#brep-s5">05 Клиенты</a>
      </nav>
    </div>
    <div class="brep-kpi">${kpiHtml}</div>
    ${periodSection}${cascadeSection}${mdSection}${ecoSection}${clientsSection}
    <div class="geohint" style="padding:8px 4px">Отклонения — в процентных пунктах к плану (КТГ 97, КВЛ 99, КИП 99,
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
        const vat = order.cash ? 0 : /(?<![\p{L}\p{N}])ИП(?![\p{L}\p{N}])/iu.test(order.customer_name || '')
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
        `Смена продаж: внесено заявок ${createdDay.length} на ${rub(createdSum)} (ср. чек ${rub(createdDay.length ? createdSum / createdDay.length : 0)}) · назначено рейсов: ${assignedDay}`,
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
          Смена продаж: внесено <b>${createdDay.length}</b> заявок на <b>${rub(createdSum)}</b>
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
  container.querySelector('#bossInventory').onclick = () => inventoryDialog(context, 'all');
  container.querySelector('#bossParkReport').onclick = () => parkReportDialog(context);
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
