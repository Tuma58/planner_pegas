// Кабина руководителя — перенос приборной панели из прототипа ТК 21:
// круговые приборы (gaugeSVG), «вид из лобового стекла» (windshield), LCD, планка плана,
// светофоры, P&L и простой по причинам. Данные — GET /api/reports (сервер считает
// экономику и каскад утилизации КТГ×КВЛ×КИП по машино-дням).
import { api, escapeHtml, toast } from './api.js';

const rub = value => `${Math.round(Number(value || 0)).toLocaleString('ru-RU')} ₽`;
const pct = value => `${(value * 100).toFixed(1)}%`;

function cpt(cx, cy, r, deg) {
  const a = (deg - 90) * Math.PI / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

function arcP(cx, cy, r, d0, d1) {
  const [x0, y0] = cpt(cx, cy, r, d0);
  const [x1, y1] = cpt(cx, cy, r, d1);
  const large = (d1 - d0) > 180 ? 1 : 0;
  return `M${x0.toFixed(1)} ${y0.toFixed(1)} A${r} ${r} 0 ${large} 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`;
}

export function gaugeSVG(frac, valTxt, name, sub, kind, warm) {
  const S = 225, SW = 270;
  frac = Math.max(0, Math.min(1, frac));
  const cx = 100, cy = 100, Rz = 76, Rt = 87, Rn = 61, Rnd = 66;
  const z = (a, b) => arcP(cx, cy, Rz, S + a * SW, S + b * SW);
  const zones = kind === 'tach'
    ? `<path d="${z(0, .45)}" class="zred"/><path d="${z(.45, .78)}" class="zamb"/><path d="${z(.78, 1)}" class="zgrn"/>`
    : `<path d="${z(0, .6)}" class="zred"/><path d="${z(.6, .85)}" class="zamb"/><path d="${z(.85, 1)}" class="zgrn"/>`;
  let ticks = '', nums = '';
  for (let i = 0; i <= 10; i++) {
    const f = i / 10, d = S + f * SW;
    const [a1, b1] = cpt(cx, cy, Rt, d), [a2, b2] = cpt(cx, cy, Rt - 12, d);
    ticks += `<line x1="${a1.toFixed(1)}" y1="${b1.toFixed(1)}" x2="${a2.toFixed(1)}" y2="${b2.toFixed(1)}" class="tmaj"/>`;
    const [nx, ny] = cpt(cx, cy, Rn, d);
    nums += `<text x="${nx.toFixed(1)}" y="${(ny + 4).toFixed(1)}" class="tnum">${Math.round(f * 100)}</text>`;
    if (i < 10) for (let j = 1; j < 5; j++) {
      const d2 = S + (f + j / 50) * SW;
      const [c1, e1] = cpt(cx, cy, Rt, d2), [c2, e2] = cpt(cx, cy, Rt - 6, d2);
      ticks += `<line x1="${c1.toFixed(1)}" y1="${e1.toFixed(1)}" x2="${c2.toFixed(1)}" y2="${e2.toFixed(1)}" class="tmin"/>`;
    }
  }
  const vd = S + frac * SW;
  const shape = `<polygon points="${cx},${(cy - Rnd).toFixed(1)} ${cx - 7},${cy} ${cx + 7},${cy}" class="needle"/>`;
  const anim = warm
    ? `<animateTransform attributeName="transform" type="rotate" values="${S} ${cx} ${cy}; ${S + SW} ${cx} ${cy}; ${vd.toFixed(1)} ${cx} ${cy}" keyTimes="0;0.5;1" dur="1.7s" calcMode="spline" keySplines="0.35 0 0.25 1; 0.25 0 0 1" fill="freeze"/>`
    : '';
  const jbeg = (-(name.charCodeAt(0) % 23) / 10).toFixed(1);
  const jitter = `<animateTransform attributeName="transform" type="rotate" additive="sum" values="0 ${cx} ${cy};0.5 ${cx} ${cy};-0.35 ${cx} ${cy};0.45 ${cx} ${cy};-0.5 ${cx} ${cy};0.25 ${cx} ${cy};-0.2 ${cx} ${cy};0 ${cx} ${cy}" dur="2.4s" begin="${jbeg}s" repeatCount="indefinite"/>`;
  const needle = `<g transform="rotate(${vd.toFixed(1)} ${cx} ${cy})">${shape}${anim}${jitter}</g>`;
  return `<svg viewBox="0 0 200 200" class="rgauge ${kind || ''}">
    <circle cx="100" cy="100" r="99" class="bezel"/><circle cx="100" cy="100" r="90" class="face"/>
    ${zones}${ticks}${nums}
    <text x="100" y="84" class="gbigval">${valTxt}</text>
    <text x="100" y="126" class="gname">${name}</text><text x="100" y="143" class="gsub">${sub}</text>
    ${needle}
    <circle cx="100" cy="100" r="10" class="hub"/><circle cx="100" cy="100" r="4" class="hubc"/></svg>`;
}

const lcdRow = (label, value, cls) =>
  `<div class="lcdrow ${cls || ''}"><span>${label}</span><b>${value}</b></div>`;

const dashLight = (count, label, info) =>
  `<div class="warnlight ${count > 0 ? 'on' : ''} ${info ? 'info' : ''}"><div class="wn">${count}</div><div class="wl">${label}</div></div>`;

export function windshield(factRev, planRev, projRev) {
  const W = 1000, H = 300, hz = 150, vp = 500;
  const money = n => Math.round(n).toLocaleString('ru-RU');
  let dashes = '';
  for (let i = 0; i < 7; i++) {
    dashes += `<rect class="ldash" x="-5" y="-11" width="10" height="22" style="animation-delay:${(-(i / 7 * 3)).toFixed(2)}s"/>`;
  }
  const sign = (x, y, tag, val, col) => `<line x1="${x}" y1="${y - 4}" x2="${x}" y2="${y + 40}" stroke="#59626c" stroke-width="4"/>
     <rect x="${x - 96}" y="${y - 60}" width="192" height="54" rx="9" fill="${col}" stroke="#f2f5f2" stroke-width="2"/>
     <text x="${x}" y="${y - 40}" text-anchor="middle" fill="#dfe9e2" font-size="12.5" font-weight="700" letter-spacing="0.5">${tag}</text>
     <text x="${x}" y="${y - 17}" text-anchor="middle" fill="#ffffff" font-size="18" font-weight="800">${val} ₽</text>`;
  const planCol = !planRev ? '#5a6570' : (projRev >= planRev ? '#4c6b57' : (projRev >= planRev * 0.9 ? '#7c6a44' : '#7c4f49'));
  const planPct = planRev
    ? `<text x="${vp}" y="${hz - 64}" text-anchor="middle" fill="#eef3f7" font-size="12" font-weight="700">факт ${Math.round(factRev / planRev * 100)}% · прогноз ${Math.round(projRev / planRev * 100)}%</text>`
    : '';
  return `<svg viewBox="0 0 ${W} ${H}" class="wshield" preserveAspectRatio="xMidYMid slice">
    <defs>
      <linearGradient id="wsky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#95acc2"/><stop offset="0.65" stop-color="#c6d2dd"/><stop offset="1" stop-color="#e3d7c4"/></linearGradient>
      <linearGradient id="wroad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5b626b"/><stop offset="1" stop-color="#383d44"/></linearGradient>
      <radialGradient id="wsun" cx="50%" cy="100%" r="55%"><stop offset="0" stop-color="#f4ecdd" stop-opacity="0.85"/><stop offset="1" stop-color="#f4ecdd" stop-opacity="0"/></radialGradient>
      <linearGradient id="wrefl" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#cdd6de" stop-opacity="0"/><stop offset="1" stop-color="#cdd6de" stop-opacity="0.15"/></linearGradient>
      <radialGradient id="wglow" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#eef3f7" stop-opacity="0.24"/><stop offset="1" stop-color="#eef3f7" stop-opacity="0"/></radialGradient></defs>
    <rect x="0" y="0" width="${W}" height="${hz}" fill="url(#wsky)"/>
    <ellipse cx="${vp}" cy="${hz}" rx="300" ry="86" fill="url(#wsun)"/>
    <rect x="0" y="${hz}" width="${W}" height="${H - hz}" fill="#6f7d64"/>
    <polygon points="${vp - 8},${hz} ${vp + 8},${hz} 990,${H} 10,${H}" fill="url(#wroad)"/>
    ${dashes}
    ${sign(250, hz, 'ВЫРУЧКА · ФАКТ', money(factRev), '#3f5a6b')}
    ${sign(750, hz, 'ВЫРУЧКА · ПРОГНОЗ', money(projRev), '#3f5a6b')}
    ${planPct}${sign(vp, hz - 46, 'ЦЕЛЬ · ПЛАН', planRev ? money(planRev) : 'задать', planCol)}
    <g opacity="0.5">
      <rect x="0" y="${H - 66}" width="${W}" height="66" fill="url(#wrefl)"/>
      <ellipse cx="288" cy="${H - 6}" rx="150" ry="42" fill="url(#wglow)"/>
      <ellipse cx="712" cy="${H - 6}" rx="150" ry="42" fill="url(#wglow)"/>
      <path d="${arcP(288, H + 30, 58, 206, 334)}" fill="none" stroke="#eef3f7" stroke-width="4" opacity="0.35"/>
      <path d="${arcP(712, H + 30, 58, 206, 334)}" fill="none" stroke="#eef3f7" stroke-width="4" opacity="0.35"/>
    </g>
    <polygon points="60,0 220,0 -140,${H} -300,${H}" fill="#ffffff" opacity="0.05"/>
    <polygon points="660,0 800,0 470,${H} 330,${H}" fill="#ffffff" opacity="0.045"/></svg>`;
}

const monthOf = iso => `${String(iso).slice(0, 7)}-01`;

// Главный рендер кабины. context: { state, onReload, openReport }.
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
  const planPeriod = monthOf(from);
  const revenuePlan = Number((state.data.revenuePlans || [])
    .find(item => item.period_start === planPeriod)?.target_net || 0);
  const factRev = report.factRevenue;
  const projRev = report.netRevenue;
  const warm = state.bossWarm !== false;
  state.bossWarm = false;
  const immersive = state.bossImmersive !== false;
  const exceptions = state.exceptions || { conflicts: [], critical: [], rejected: [] };
  const idleDays = md.repair + md.noDriver + md.shift + md.idle;
  const loadFrac = u.normDays ? u.workDays / u.normDays : 0;

  const exFact = revenuePlan ? factRev / revenuePlan : 0;
  const exProj = revenuePlan ? projRev / revenuePlan : 0;
  const pbcls = exProj >= 1 ? '' : (exProj >= 0.9 ? 'warn' : 'bad');
  const planbar = revenuePlan
    ? `<div class="planbar">
        <div class="planbar-l"><span>ВЫПОЛНЕНИЕ ПЛАНА ВЫРУЧКИ</span><b class="${pbcls === 'bad' ? 'neg' : ''}">факт ${Math.round(exFact * 100)}% · прогноз ${Math.round(exProj * 100)}%</b></div>
        <div class="pbtrack"><div class="pbfact ${pbcls}" style="width:${Math.min(100, exFact * 100).toFixed(0)}%"></div><div class="pbproj" style="left:${Math.min(100, exProj * 100).toFixed(0)}%"></div></div>
        <div class="planbar-s">План ${rub(revenuePlan)} · выполнено ${rub(factRev)} · прогноз ${rub(projRev)}${exProj < 1 ? ` · до цели ${rub(Math.max(0, revenuePlan - projRev))}` : ' · цель достигается'}</div>
      </div>`
    : '<div class="planhint">🎯 План выручки не задан — введите цель в поле «План выручки» в консоли выше</div>';

  const lcds = lcdRow('ВЫРУЧКА Б.НДС', rub(report.netRevenue)) +
    lcdRow('МАРЖ. ДОХОД', rub(report.contribution)) +
    lcdRow('ПОСТОЯННЫЕ', rub(report.fixed)) +
    lcdRow('ОПЕР. ПРИБЫЛЬ', rub(report.operationalProfit), `accent${report.operationalProfit < 0 ? ' neg' : ''}`) +
    lcdRow('УПУЩЕНО', rub(u.lostProfit), 'warn');
  const lights = dashLight(exceptions.conflicts.length, 'Конфликты') +
    dashLight(exceptions.critical.length, 'Критич.') +
    dashLight(exceptions.rejected.length, 'Отклон.') +
    dashLight(Math.round(idleDays), 'Простой', true);

  const marginGauge = gaugeSVG(Math.max(0, report.operationalMargin) / 0.40,
    `${(report.operationalMargin * 100).toFixed(1)}%`, 'ОПЕР. МАРЖА', 'шкала ×2,5', null, warm);
  const loadGauge = gaugeSVG(loadFrac, `${Math.round(loadFrac * 100)}%`, 'ЗАГРУЗКА', 'парк · норма', 'fuel', warm);
  const cluster = immersive
    ? `<div class="cluster">
        <div class="gcol">
          <div class="gbox big">${gaugeSVG(u.ktg, pct(u.ktg), 'КТГ', 'тахометр · ТОиР', 'tach', warm)}</div>
          <div class="grow">${gaugeSVG(u.kvl, pct(u.kvl), 'КВЛ', 'водители', null, warm)}${gaugeSVG(u.overall, pct(u.overall), 'В РАБОТЕ', 'от списка', null, warm)}</div>
        </div>
        <div class="centerstack"><div class="lcd">${lcds}</div>${planbar}<div class="lights">${lights}</div></div>
        <div class="gcol">
          <div class="gbox big">${gaugeSVG(u.kip, pct(u.kip), 'КИП', 'спидометр · логистика', 'speedo', warm)}</div>
          <div class="grow">${marginGauge}${loadGauge}</div>
        </div>
      </div>`
    : `<div class="cluster compact">
        <div class="gstrip">
          ${gaugeSVG(u.kip, pct(u.kip), 'КИП', 'спидометр · логистика', 'speedo', warm)}
          ${gaugeSVG(u.ktg, pct(u.ktg), 'КТГ', 'тахометр · ТОиР', 'tach', warm)}
          ${gaugeSVG(u.kvl, pct(u.kvl), 'КВЛ', 'водители', null, warm)}
          ${gaugeSVG(u.overall, pct(u.overall), 'В РАБОТЕ', 'от списка', null, warm)}
          ${marginGauge}${loadGauge}
        </div>
        <div class="infostrip"><div class="lcd">${lcds}</div>${planbar}<div class="lights">${lights}</div></div>
      </div>`;

  const downtime = [
    ['В ремонте', 'КТГ · ТОиР', md.repair, '#ad9268'],
    ['Без водителя', 'КВЛ · Упр. водителями', md.noDriver, '#a4906f'],
    ['Пересменка', 'смена вахты (вод.)', md.shift, '#6d84a6'],
    ['Без рейса', 'КИП · Логистика', md.idle, '#8a86a4']
  ];
  const downtimeTotal = md.repair + md.noDriver + md.shift + md.idle;
  const downtimeRows = downtime.map(row => `<tr><td><span class="dotc" style="background:${row[3]}"></span>${row[0]}</td>
    <td class="muted">${row[1]}</td><td class="num">${row[2]}</td><td class="num">${downtimeTotal ? Math.round(row[2] / downtimeTotal * 100) : 0}%</td></tr>`).join('');

  const fmtDay = iso => new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' })
    .format(new Date(`${iso}T00:00:00Z`));
  const periodLabel = new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(`${planPeriod}T00:00:00Z`));
  const revbanner = `<div class="revbanner">
        <div class="rbcard"><span>ВЫРУЧКА · ФАКТ</span><b>${rub(factRev)}</b></div>
        <div class="rbcard plan"><span>ПЛАН · ${escapeHtml(periodLabel)}</span><b>${revenuePlan ? rub(revenuePlan) : '—'}</b></div>
        <div class="rbcard"><span>ПРОГНОЗ ИТОГА</span><b>${rub(projRev)}</b>${revenuePlan ? `<i class="${pbcls === 'bad' ? 'neg' : ''}">${Math.round(exProj * 100)}% плана</i>` : ''}</div>
        <div class="rbmeta">${fmtDay(from)} – ${fmtDay(to)} · ${u.days} дн · по выгрузке</div>
      </div>`;

  container.innerHTML = `<div class="bosswrap">
    <div class="cockpit${immersive ? ' immersive' : ''}">
      ${immersive
        ? `<div class="wframe">${windshield(factRev, revenuePlan, projRev)}
            <div class="mirror">${fmtDay(from)} – ${fmtDay(to)} · ${u.days} дн · учёт по выгрузке · каскад КТГ×КВЛ×КИП</div>
            <div class="wtitle">PegasLogistic · кабина руководителя</div>
          </div>`
        : revbanner}
      <div class="console">
        <span class="cnl">Период отчёта</span>
        <input type="date" id="bossFrom" value="${from}">
        <span style="color:#8b97a3">–</span>
        <input type="date" id="bossTo" value="${to}">
        <button class="button ghost small" id="bossMonth">Текущий месяц</button>
        <button class="button ghost small" id="bossView">${immersive ? '▣ Компактно' : '🚗 Вид из окна'}</button>
        <span class="cnl" style="margin-left:12px">План выручки</span>
        <input type="number" id="bossPlan" placeholder="цель, ₽" value="${revenuePlan || ''}" style="width:130px">
        <button class="button ghost small" id="bossClose" title="Зафиксировать период в истории">🏁 Закрыть период</button>
        <select id="bossReportKind" style="margin-left:auto">
          <option value="summary">Сводный</option><option value="util">Использование парка</option>
          <option value="econ">Экономика по типам ТС</option><option value="clients">Экономика по клиентам</option>
          <option value="rejected">Отклонённые рейсы</option>
          <option value="rejected-orders">Отклонённые заявки</option>
          <option value="history">История периодов</option>
        </select>
        <button class="button small" id="bossReport">📄 Сформировать</button>
      </div>
      ${cluster}
      ${immersive ? '<div class="wheel"><div class="wheelrim"><div class="wheelhub">PL</div></div></div>' : ''}
    </div>
    <div class="rgrid">
      <div class="rcard"><h3>Простой по причинам · машино-дни за период</h3>
        <table class="rtable"><thead><tr><th>Причина</th><th>Ответственный</th><th class="num">Маш-дни</th><th class="num">Доля</th></tr></thead>
        <tbody>${downtimeRows}<tr class="tot"><td>Итого простой</td><td></td><td class="num">${downtimeTotal}</td><td class="num">100%</td></tr></tbody></table></div>
      <div class="rcard"><h3>Операционная прибыль за период · P&L</h3>
        <div class="mdrow"><span>Выручка без НДС</span><b>${rub(report.netRevenue)}</b></div>
        <div class="mdrow"><span>− Переменные (путевые, страх./дороги, водитель, ХОУ)</span><b>${rub(report.netRevenue - report.contribution)}</b></div>
        <div class="mdrow"><span>= Маржинальный доход</span><b>${rub(report.contribution)}</b></div>
        <div class="mdrow"><span>− Постоянные (лизинг+накладные · ${u.vehicles}×${u.days} маш-дней)</span><b>${rub(report.fixed)}</b></div>
        <div class="mdrow big"><span>= Операционная прибыль</span><b class="${report.operationalProfit < 0 ? 'neg' : ''}">${rub(report.operationalProfit)}</b></div>
        <div class="mdrow"><span>Марж. доход на машино-день</span><b>${rub(u.marginPerTripDay)}</b></div></div>
    </div>
    <div class="geohint" style="padding:6px 16px">Приборы за выбранный период, рейс учитывается <b>по дате выгрузки</b>.
      «🚗 Вид из окна» включает панораму дороги; «▣ Компактно» убирает её для анализа.</div>
  </div>`;

  const rerender = () => renderBoss(container, context);
  const applyRange = () => {
    const a = document.getElementById('bossFrom').value;
    const b = document.getElementById('bossTo').value;
    if (!a || !b || b <= a) { toast('Период задан неверно', 'error'); return; }
    state.bossFrom = a;
    state.bossTo = b;
    rerender();
  };
  document.getElementById('bossFrom').onchange = applyRange;
  document.getElementById('bossTo').onchange = applyRange;
  document.getElementById('bossMonth').onclick = () => {
    state.bossFrom = null; state.bossTo = null; rerender();
  };
  document.getElementById('bossView').onclick = () => {
    state.bossImmersive = !immersive; state.bossWarm = true; rerender();
  };
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
}
