// PDF-презентация «Сводка периода» (заказ руководителя 03.11): восемь
// альбомных страниц — титул, ключевые цифры, КТГ/КВЛ/КИП, выручка и
// темп, машины на линии, пробег по неделям, опоздания, итог периода.
// Данные — briefReportData (канон) + дневные ряды; формат повторяет
// выпуск 27.10, который руководитель принял за образец.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PdfLite } from './pdf-lite.mjs';

const fontsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fonts');
const FONT_R = fs.readFileSync(path.join(fontsDir, 'DejaVuSans.ttf'));
const FONT_B = fs.readFileSync(path.join(fontsDir, 'DejaVuSans-Bold.ttf'));

const C = { ink: '#1a2430', sub: '#5a6b86', blue: '#2e5bff', green: '#0b8a52',
  red: '#d23d2d', orange: '#d97b00', gray: '#aab4c2', bar: '#4f7df7',
  grid: '#e7ebf1', card: '#eef2f7', line: '#c9d2de' };
const W = 841.89, H = 595.28, ML = 48, MR = 48;
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const ruDate = iso => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
const dm = iso => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
const comma = value => String(value).replace('.', ',');
const isoWeek = iso => {
  const d = new Date(Date.parse(`${iso}T00:00:00Z`));
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const fday = (firstThu.getUTCDay() + 6) % 7;
  firstThu.setUTCDate(firstThu.getUTCDate() - fday + 3);
  return 1 + Math.round((d - firstThu) / (7 * 86_400_000));
};
const deltaStr = (cur, prev) => {
  if (!Number.isFinite(cur) || !Number.isFinite(prev) || !prev) return '';
  const pct = (cur - prev) / prev * 100;
  if (Math.abs(pct) < 0.5) return '= к базе';
  return `${pct > 0 ? '▲' : '▼'} ${Math.abs(pct).toFixed(1)}% к базе`;
};

export function renderBriefDeckPdf(deck) {
  const { brief: B, extra: X } = deck;
  const P = B.prev || {};
  const S = B.series || { days: [], net: [], km: [], online: [] };
  const n = S.days.length;
  const pdf = new PdfLite({ landscape: true });
  pdf.addFont('R', FONT_R);
  pdf.addFont('B', FONT_B);
  let pageNo = 0;

  const header = (title, sub) => {
    pdf.page();
    pageNo += 1;
    pdf.text(ML, 52, title, { size: 19, font: 'B', color: C.ink });
    pdf.text(ML, 70, sub, { size: 8.5, color: C.sub });
    pdf.line(ML, 78, W - MR, 78, { color: C.blue, width: 1.8 });
  };
  const footer = () => {
    pdf.text(ML, H - 22, `Пегас-Авто · сводка периода · цифры = штатный отчёт «Сводка периода» на ${deck.generatedAt}`,
      { size: 6.5, color: C.sub });
    pdf.text(W - MR, H - 22, String(pageNo), { size: 6.5, color: C.sub, align: 'right' });
  };
  const card = (x, y, w, h, label, value, note, vcolor = C.ink, vsize = 19) => {
    pdf.rect(x, y, w, h, { fill: C.card });
    pdf.text(x + 10, y + 20, label, { size: 7.5, color: C.sub });
    pdf.text(x + 10, y + h / 2 + 8, value, { size: vsize, font: 'B', color: vcolor });
    pdf.text(x + 10, y + h - 11, note, { size: 6.8, color: C.sub });
  };
  const cardRow = (y, cards) => {
    const cw = (W - ML - MR - 3 * 18) / 4;
    cards.forEach((c, i) => card(ML + i * (cw + 18), y, cw, 102, ...c));
  };
  const dashed = (x1, y1, x2, y2, opts) => {
    const len = Math.hypot(x2 - x1, y2 - y1);
    const steps = Math.max(1, Math.floor(len / 9));
    for (let i = 0; i < steps; i += 1) {
      const a = i / steps, b = (i + 0.55) / steps;
      pdf.line(x1 + (x2 - x1) * a, y1 + (y2 - y1) * a, x1 + (x2 - x1) * b, y1 + (y2 - y1) * b, opts);
    }
  };
  // Оси с сеткой: top/левая подпись; возвращает маппинг значений в y.
  const frame = (top, ch, maxv, unit) => {
    for (let g = 0; g <= 4; g += 1) {
      const gy = top + ch - ch * g / 4;
      pdf.line(ML + 34, gy, W - MR, gy, { color: C.grid, width: 0.5 });
      pdf.text(ML + 30, gy + 2.5, unit(maxv * g / 4), { size: 6.5, color: C.sub, align: 'right' });
    }
    return value => top + ch - ch * value / maxv;
  };
  const dayTicks = (top, ch, days, xAt) => {
    const step = Math.max(1, Math.round(days.length / 10));
    days.forEach((day, i) => {
      if (i % step && i !== days.length - 1) return;
      pdf.text(xAt(i), top + ch + 11, dm(day), { size: 6.5, color: C.sub, align: 'center' });
    });
  };

  // ── 1. Титул ──
  pdf.page(); pageNo += 1;
  pdf.text(ML + 10, 200, 'Сводка периода', { size: 34, font: 'B', color: C.ink });
  pdf.text(ML + 10, 245, `${ruDate(B.from).replace(` ${B.from.slice(0, 4)}`, '')} – ${ruDate(B.to)} · недели ${isoWeek(B.from)}–${isoWeek(B.to)}`,
    { size: 22, font: 'B', color: C.blue });
  pdf.text(ML + 10, 290, `База сравнения: ${ruDate(B.prevFrom).replace(` ${B.prevFrom.slice(0, 4)}`, '')} – ${ruDate(B.prevTo)}` +
    (B.base === 'month' ? ' (те же числа месяца)' : ' (предыдущий период той же длины)'), { size: 11, color: '#3a4656' });
  pdf.text(ML + 10, 312, `Автопарк: ${B.fleet} ТС в работе · выручка без НДС · все итоги — из штатного отчёта «Сводка периода»`,
    { size: 11, color: '#3a4656' });
  pdf.text(ML + 10, H - 60, `ООО «Пегас-Авто» · подготовлено автоматически из данных «Пегас-Авто · Планер» · ${deck.generatedAt}`,
    { size: 8, color: C.sub });

  // ── 2. Ключевые цифры ──
  header('Ключевые цифры периода',
    `${dm(B.from)}–${dm(B.to)} против ${dm(B.prevFrom)}–${dm(B.prevTo)}; все значения — из штатной сводки планера`);
  cardRow(120, [
    ['Выручка б/НДС', `${comma((B.factNet / 1e6).toFixed(1))} млн`,
      B.planNet ? `план ${(B.planNet / 1e6).toFixed(0)} · выполнение ${B.planPct}%` : 'план на период не задан'],
    ['Рейсов выполнено', String(B.orders), deltaStr(B.orders, P.orders)],
    ['Средний чек рейса', `${comma((B.avgCheck / 1000).toFixed(1))} т.руб`, deltaStr(B.avgCheck, P.avgCheck), C.green],
    ['На линии, ср./сут', `${B.onLineAvg} ТС`, deltaStr(B.onLineAvg, P.onLineAvg)]
  ]);
  cardRow(242, [
    ['Пробег парка', `${comma((B.km / 1e6).toFixed(2))} млн км`,
      `${deltaStr(B.km, P.km)} · ${B.kmPerDayPerVehicle} км/сут·ТС (цель ${B.kmTarget})`],
    ['Опозданий >1 ч', String(B.lateUnload), deltaStr(B.lateUnload, P.lateUnload),
      B.lateUnload <= (P.lateUnload || 0) ? C.green : C.red],
    ['Ремонт, машино-дни', String(B.repairMd), deltaStr(B.repairMd, P.repairMd),
      B.repairMd <= (P.repairMd || 0) ? C.green : C.red],
    ['Без водителя, м-дни', String(B.noDriverMd), deltaStr(B.noDriverMd, P.noDriverMd),
      B.noDriverMd <= (P.noDriverMd || 0) ? C.green : C.red]
  ]);
  pdf.text(ML, 380, 'Выручка и рейсы — по дате фактической выгрузки; план периода — доля месячных планов на эти дни; пробег — отчёт «Пробеги» (журнал одометров с фолбэками).',
    { size: 7.5, color: C.sub });
  footer();

  // ── 3. КТГ · КВЛ · КИП ──
  const repAvg = X.repairCur.reduce((s, v) => s + v, 0) / Math.max(1, X.repairCur.length);
  const repAvgPrev = (P.repairMd || 0) / Math.max(1, X.prevDays);
  const ktg = (B.fleet - repAvg) / B.fleet * 100;
  const ktgPrev = (B.fleet - repAvgPrev) / B.fleet * 100;
  const kvl = B.onLineAvg / Math.max(1, B.fleet - repAvg) * 100;
  const kvlPrev = (P.onLineAvg || 0) / Math.max(1, B.fleet - repAvgPrev) * 100;
  header('КТГ · КВЛ · КИП', 'коэффициенты парка за период; средние — из машино-дней штатной сводки');
  cardRow(104, [
    ['КТГ — техническая готовность', `${comma(ktg.toFixed(1))}%`,
      `база ${comma(ktgPrev.toFixed(1))}% · ремонт ${B.repairMd} м-дн`, ktg < ktgPrev ? C.red : C.ink],
    ['КВЛ — выпуск на линию', `${comma(kvl.toFixed(1))}%`,
      `база ${comma(kvlPrev.toFixed(1))}% · на линии ${B.onLineAvg} из ${B.fleet}`],
    ['КИП — использование пробега', `${B.loadedPct}%`, `база ${P.loadedPct ?? '—'}% · гружёный км / общий`],
    ['Резерв по готовности', `${repAvg.toFixed(0)} ТС/сут`, 'в ремонте в среднем каждый день', C.orange]
  ]);
  {
    const top = 240, ch = 270;
    const ktgD = X.repairCur.map(r => (B.fleet - r) / B.fleet * 100);
    const kvlD = S.online.map((o, i) => o / Math.max(1, B.fleet - X.repairCur[i]) * 100);
    const maxv = Math.max(100, ...kvlD) + 2;
    const minv = Math.min(70, ...ktgD, ...kvlD) - 2;
    const yAt = value => top + ch - ch * (value - minv) / (maxv - minv);
    for (let g = 0; g <= 4; g += 1) {
      const val = minv + (maxv - minv) * g / 4;
      pdf.line(ML + 34, yAt(val), W - MR, yAt(val), { color: C.grid, width: 0.5 });
      pdf.text(ML + 30, yAt(val) + 2.5, Math.round(val), { size: 6.5, color: C.sub, align: 'right' });
    }
    const xAt = i => ML + 34 + (W - MR - ML - 34) * i / Math.max(1, n - 1);
    pdf.poly(ktgD.map((v, i) => [xAt(i), yAt(v)]), { color: '#1f9e63', width: 1.6 });
    pdf.poly(kvlD.map((v, i) => [xAt(i), yAt(v)]), { color: C.blue, width: 1.6 });
    dayTicks(top, ch, S.days, xAt);
    pdf.text(ML + 40, top + 14, `— КТГ по дням · ср. ${comma(ktg.toFixed(1))}%`, { size: 8, color: '#1f9e63' });
    pdf.text(ML + 190, top + 14, `— КВЛ по дням · ср. ${comma(kvl.toFixed(1))}%`, { size: 8, color: C.blue });
  }
  footer();

  // ── 4. Выручка по дням и темп ──
  header('Выручка по дням и темп к плану периода',
    `столбики — выгружено за день; зелёная — накопительно; пунктир — равномерный план периода ${comma((B.planNet / 1e6).toFixed(1))} млн`);
  {
    const top = 120, ch = 380;
    const mln = S.net.map(v => v / 1e6);
    const maxBar = Math.max(...mln, 0.1) * 1.1;
    const yBar = frame(top, ch, maxBar, v => comma(v.toFixed(1)));
    const plotW = W - MR - ML - 34;
    const bw = Math.max(2, plotW / n - 3);
    mln.forEach((v, i) => {
      const x = ML + 34 + plotW * i / n;
      pdf.rect(x, yBar(v), bw, top + ch - yBar(v), { fill: C.bar });
    });
    // Накопительно и план — правая шкала.
    const cum = [];
    let run = 0;
    for (const v of mln) { run += v; cum.push(run); }
    const maxCum = Math.max(run, B.planNet / 1e6) * 1.06;
    const yCum = value => top + ch - ch * value / maxCum;
    const xMid = i => ML + 34 + plotW * i / n + bw / 2;
    pdf.poly(cum.map((v, i) => [xMid(i), yCum(v)]), { color: C.green, width: 2 });
    if (B.planNet) dashed(xMid(0), yCum(B.planNet / 1e6 / n), xMid(n - 1), yCum(B.planNet / 1e6), { color: '#6a7686', width: 1.2 });
    for (let g = 1; g <= 4; g += 1) {
      pdf.text(W - MR + 4, yCum(maxCum * g / 4) + 2.5, Math.round(maxCum * g / 4), { size: 6.5, color: C.sub });
    }
    dayTicks(top, ch, S.days, xMid);
    pdf.text(ML + 40, top + 14, `— Накопительно · ${comma(run.toFixed(1))} млн`, { size: 8, color: C.green });
    if (B.planNet) pdf.text(ML + 220, top + 14, `--- План периода · ${comma((B.planNet / 1e6).toFixed(1))} млн`, { size: 8, color: '#6a7686' });
    pdf.text(ML, top + ch + 26, 'левая шкала — млн руб. в день · правая — млн руб. накопительно', { size: 7, color: C.sub });
  }
  footer();

  // ── 5. Машины на линии по дням ──
  header('Машины на линии по дням', 'машина с рейсом в этот день (методика дашборда и сводки); база — пунктиром');
  {
    const top = 120, ch = 380;
    const all = [...S.online, ...X.onlinePrev, B.fleet];
    const maxv = Math.max(...all) + 3;
    const minv = Math.min(...all.filter(v => v > 0)) - 5;
    const yAt = value => top + ch - ch * (value - minv) / (maxv - minv);
    for (let g = 0; g <= 4; g += 1) {
      const val = minv + (maxv - minv) * g / 4;
      pdf.line(ML + 34, yAt(val), W - MR, yAt(val), { color: C.grid, width: 0.5 });
      pdf.text(ML + 30, yAt(val) + 2.5, Math.round(val), { size: 6.5, color: C.sub, align: 'right' });
    }
    const xAt = i => ML + 34 + (W - MR - ML - 34) * i / Math.max(1, Math.max(n, X.onlinePrev.length) - 1);
    const prevPts = X.onlinePrev.map((v, i) => [xAt(i), yAt(v)]);
    for (let i = 1; i < prevPts.length; i += 1) dashed(...prevPts[i - 1], ...prevPts[i], { color: '#6a7686', width: 1.1 });
    pdf.poly(S.online.map((v, i) => [xAt(i), yAt(v)]), { color: C.blue, width: 1.8 });
    S.online.forEach((v, i) => pdf.circle(xAt(i), yAt(v), 1.6, { fill: C.blue }));
    dashed(ML + 34, yAt(B.fleet), W - MR, yAt(B.fleet), { color: C.red, width: 0.9 });
    pdf.text(ML + 40, yAt(B.fleet) - 5, `парк ${B.fleet} ТС`, { size: 7.5, color: C.red });
    dayTicks(top, ch, S.days, xAt);
    pdf.text(ML + 40, top + 14, `— Период · ср. ${B.onLineAvg}`, { size: 8, color: C.blue });
    pdf.text(ML + 170, top + 14, `--- База · ср. ${P.onLineAvg ?? '—'}`, { size: 8, color: '#6a7686' });
  }
  footer();

  // ── 6. Пробег по неделям ──
  header('Пробег по неделям',
    'итог периода — штатный отчёт «Пробеги»; недели — по форме дневного журнала; числа — км/сутки на машину');
  {
    const segs = [];
    for (let a = 0; a < n; a += 7) segs.push([a, Math.min(a + 6, n - 1)]);
    const jo = segs.map(([a, b]) => S.km.slice(a, b + 1).reduce((s, v) => s + v, 0));
    const prevSegs = [];
    for (let a = 0; a < X.kmPrevJournal.length; a += 7) prevSegs.push([a, Math.min(a + 6, X.kmPrevJournal.length - 1)]);
    const js = prevSegs.map(([a, b]) => X.kmPrevJournal.slice(a, b + 1).reduce((s, v) => s + v, 0));
    const ko = B.km / Math.max(1, jo.reduce((s, v) => s + v, 0));
    const ks = (P.km || 0) / Math.max(1, js.reduce((s, v) => s + v, 0));
    const so = jo.map(v => v * ko), ss = js.map(v => v * ks);
    const top = 150, ch = 340;
    const maxv = Math.max(...so, ...ss, 1) / 1000 * 1.15;
    const yAt = frame(top, ch, maxv, v => Math.round(v));
    const groupW = (W - MR - ML - 34) / segs.length;
    segs.forEach(([a, b], i) => {
      const cx = ML + 34 + groupW * i + groupW / 2;
      const bw = Math.min(40, groupW / 3);
      pdf.rect(cx - bw - 3, yAt(so[i] / 1000), bw, top + ch - yAt(so[i] / 1000), { fill: C.bar });
      if (ss[i]) pdf.rect(cx + 3, yAt(ss[i] / 1000), bw, top + ch - yAt(ss[i] / 1000), { fill: C.gray });
      pdf.text(cx - 3 - bw / 2, yAt(so[i] / 1000) - 5, Math.round(so[i] / ((b - a + 1) * B.fleet)), { size: 7.5, color: C.blue, align: 'center' });
      if (ss[i]) {
        const [pa, pb] = prevSegs[i] || [0, 0];
        pdf.text(cx + 3 + bw / 2, yAt(ss[i] / 1000) - 5, Math.round(ss[i] / ((pb - pa + 1) * B.fleet)), { size: 7.5, color: '#6a7686', align: 'center' });
      }
      pdf.text(cx, top + ch + 12, `нед. ${i + 1} (${dm(S.days[a]).slice(0, 2)}–${dm(S.days[b]).slice(0, 2)})`, { size: 7, color: C.sub, align: 'center' });
    });
    pdf.text(ML + 40, top - 16, `■ Период · ${Math.round(B.km / 1000)} т.км · ${B.kmPerDayPerVehicle} км/сут·ТС`, { size: 8, color: C.blue });
    pdf.text(ML + 280, top - 16, `■ База · ${Math.round((P.km || 0) / 1000)} т.км · ${P.kmPerDayPerVehicle ?? '—'} км/сут·ТС`, { size: 8, color: '#6a7686' });
  }
  footer();

  // ── 7. Опоздания на выгрузку по дням ──
  header('Опоздания на выгрузку по дням',
    'выгруженные рейсы, прибывшие на конечную точку позже плана более чем на час (по дате выгрузки)');
  {
    const top = 120, ch = 380;
    const maxv = Math.max(...X.lateCur, ...X.latePrev, 1) * 1.15;
    const yAt = frame(top, ch, maxv, v => Math.round(v));
    const plotW = W - MR - ML - 34;
    const days = Math.max(X.lateCur.length, X.latePrev.length);
    const slot = plotW / days;
    const bw = Math.max(2, slot / 2 - 1.5);
    for (let i = 0; i < days; i += 1) {
      const x = ML + 34 + slot * i;
      if (X.lateCur[i]) pdf.rect(x, yAt(X.lateCur[i]), bw, top + ch - yAt(X.lateCur[i]), { fill: '#e05252' });
      if (X.latePrev[i]) pdf.rect(x + bw + 1, yAt(X.latePrev[i]), bw, top + ch - yAt(X.latePrev[i]), { fill: C.gray });
    }
    dayTicks(top, ch, S.days, i => ML + 34 + slot * i + bw);
    pdf.text(ML + 40, top + 14, `■ Период · всего ${X.lateCur.reduce((s, v) => s + v, 0)}`, { size: 8, color: '#e05252' });
    pdf.text(ML + 190, top + 14, `■ База · всего ${X.latePrev.reduce((s, v) => s + v, 0)}`, { size: 8, color: '#6a7686' });
  }
  footer();

  // ── 8. Итог периода ──
  header('Итог периода', B.planNet ? `факт против плана ${comma((B.planNet / 1e6).toFixed(1))} млн` : 'главные факты периода');
  {
    const best = S.net.reduce((m, v, i) => (v > S.net[m] ? i : m), 0);
    const worst = S.net.reduce((m, v, i) => (v < S.net[m] ? i : m), 0);
    const gap = (B.planNet - B.factNet) / 1e6;
    cardRow(120, [
      ['Выручка периода', `${comma((B.factNet / 1e6).toFixed(2))} млн`,
        B.planNet ? `план ${(B.planNet / 1e6).toFixed(0)} · выполнение ${B.planPct}%` : ''],
      B.planNet
        ? (gap > 0
          ? ['До плана не хватило', `${comma(gap.toFixed(2))} млн`, `примерно ${comma((gap / (B.factNet / 1e6 / B.days)).toFixed(1))} средн. дня`, C.orange]
          : ['Сверх плана', `+${comma(Math.abs(gap).toFixed(2))} млн`, 'план периода перевыполнен', C.green])
        : ['Темп на парк', `${Math.round(B.factPerDay / 1000)} т₽/сут`, '', C.ink],
      ['Лучший день', `${comma((S.net[best] / 1e6).toFixed(2))} млн`,
        `${dm(S.days[best])} · худший ${dm(S.days[worst])} — ${comma((S.net[worst] / 1e6).toFixed(1))} млн`, C.green],
      ['Средний чек', `${comma((B.avgCheck / 1000).toFixed(1))} т.руб`, deltaStr(B.avgCheck, P.avgCheck), C.blue]
    ]);
    pdf.text(ML, 268, 'Что говорит период:', { size: 11, font: 'B', color: C.ink });
    const facts = [
      `· Рейсов ${B.orders} (${deltaStr(B.orders, P.orders) || 'база без изменений'}), чек ${comma((B.avgCheck / 1000).toFixed(1))} т.руб (${deltaStr(B.avgCheck, P.avgCheck) || '='}).`,
      `· Опозданий на выгрузку ${B.lateUnload} против ${P.lateUnload ?? '—'} в базе; ремонт ${B.repairMd} м-дн против ${P.repairMd ?? '—'}.`,
      `· Пробег ${Math.round(B.km / 1000)} т.км, ${B.kmPerDayPerVehicle} км/сут на машину при цели ${B.kmTarget}.`,
      B.incidents && (B.incidents.counts.act || B.incidents.counts.return)
        ? `· Внештатки: актов ${B.incidents.counts.act} · возвратов ${B.incidents.counts.return}${B.incidents.returnsClosed ? ` (закрыто ${B.incidents.returnsClosed})` : ''}.`
        : null
    ].filter(Boolean);
    facts.forEach((line, i) => pdf.text(ML, 292 + i * 22, line, { size: 9.5, color: '#3a4656' }));
  }
  footer();

  return pdf.build();
}
