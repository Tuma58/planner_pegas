// PDF-версия отчёта эксплуатации (заказ 22.09 «сохранить на компьютере»):
// те же данные opsReportData, что и HTML-страница, свёрстанные pdf-lite
// в многостраничный A4. Печатная палитра — светлая.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PdfLite, A4 } from './pdf-lite.mjs';

const fontsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fonts');
const FONT_R = fs.readFileSync(path.join(fontsDir, 'DejaVuSans.ttf'));
const FONT_B = fs.readFileSync(path.join(fontsDir, 'DejaVuSans-Bold.ttf'));

const C = { ink: '#0b0b0b', sec: '#52514e', mut: '#8a887f', grid: '#e1e0d9',
  tile: '#f2f1ee', s1: '#2a78d6', s2: '#eb6834', s3: '#1baf7a' };
const ML = 40, MR = 40, MW = A4.w - ML - MR; // поля и рабочая ширина
const fmtVal = v => Math.abs(v) >= 20 ? String(Math.round(v)) : String(+(+v).toFixed(1));

export function renderOpsReportPdf(data) {
  const { park, online, downtime, late, trend } = data;
  const T = park.total;
  const D = trend.day, WK = trend.week;
  const pdf = new PdfLite();
  pdf.addFont('R', FONT_R);
  pdf.addFont('B', FONT_B);
  pdf.page();
  let y = 52;
  const ensure = need => { if (y + need > A4.h - 44) { pdf.page(); y = 52; } };
  const h2 = label => {
    // Заголовок не должен остаться сиротой внизу страницы: если под ним
    // не помещается хотя бы график — секция начинается с новой.
    ensure(170);
    pdf.text(ML, y, label, { size: 12, font: 'B' });
    y += 6;
    pdf.line(ML, y, ML + MW, y, { color: C.grid });
    y += 14;
  };

  // ── Графики ──
  const CH = 110, PL = 30; // высота поля и отступ оси Y
  const chartFrame = mx => {
    const top = y, plotW = MW - PL;
    for (let g = 1; g <= 4; g += 1) {
      const gy = top + CH - CH * g / 4;
      pdf.line(ML + PL, gy, ML + MW, gy, { color: C.grid, width: 0.5 });
      pdf.text(ML + PL - 4, gy + 2.5, fmtVal(mx * g / 4), { size: 7, color: C.mut, align: 'right' });
    }
    pdf.line(ML + PL, top + CH, ML + MW, top + CH, { color: C.mut, width: 0.7 });
    return { top, plotW };
  };
  const axisLabels = (labels, step, xAt) => {
    for (let i = 0; i < labels.length; i += step) {
      pdf.text(Math.min(xAt(i), ML + MW - pdf.width(labels[i], 7) / 2), y + CH + 10, labels[i],
        { size: 7, color: C.mut, align: 'center' });
    }
  };
  const chartLines = (series, names, colors, labels, ymax, step) => {
    ensure(CH + 40);
    const mx = ymax || Math.max(...series.flat(), 1) * 1.15;
    const { top, plotW } = chartFrame(mx);
    const dx = plotW / Math.max(1, labels.length - 1);
    const xAt = i => ML + PL + i * dx;
    const labelStep = labels.length > 16 ? step : 1;
    series.forEach((vals, si) => {
      pdf.poly(vals.map((v, i) => [xAt(i), top + CH - CH * v / mx]), { color: colors[si], width: 1.3 });
      vals.forEach((v, i) => {
        const py = top + CH - CH * v / mx;
        pdf.circle(xAt(i), py, 1.6, { fill: colors[si] });
        if (i % labelStep === 0) {
          pdf.text(xAt(i), py + (si % 2 ? 11 : -4), fmtVal(v), { size: 6.5, color: C.sec, align: 'center' });
        }
      });
    });
    axisLabels(labels, step, xAt);
    y += CH + 18;
    // Легенда под осью.
    let lx = ML + PL;
    names.forEach((name, si) => {
      pdf.rect(lx, y - 6, 7, 7, { fill: colors[si] });
      lx += 11 + pdf.text(lx + 11, y, name, { size: 8, color: C.sec }) + 16;
    });
    y += 16;
  };
  const chartBars = (vals, labels, color, step) => {
    ensure(CH + 34);
    const mx = Math.max(...vals, 0.001) * 1.18;
    const { top, plotW } = chartFrame(mx);
    const bw = plotW / vals.length;
    vals.forEach((v, i) => {
      const h = CH * v / mx;
      pdf.rect(ML + PL + i * bw + 1, top + CH - h, bw - 2, h, { fill: color });
      pdf.text(ML + PL + i * bw + bw / 2, top + CH - h - 3, fmtVal(v), { size: 6.5, color: C.sec, align: 'center' });
      if (i % step === 0) {
        pdf.text(ML + PL + i * bw + bw / 2, top + CH + 10, labels[i], { size: 7, color: C.mut, align: 'center' });
      }
    });
    y += CH + 26;
  };
  const table = (headers, rows, widths, aligns = []) => {
    const rowH = 15;
    ensure(rowH * (rows.length + 1) + 10);
    let x = ML;
    headers.forEach((headline, i) => {
      pdf.text(aligns[i] === 'right' ? x + widths[i] - 2 : x, y, headline,
        { size: 8, font: 'B', color: C.sec, align: aligns[i] || 'left' });
      x += widths[i];
    });
    y += 5;
    pdf.line(ML, y, ML + widths.reduce((s, w) => s + w, 0), y, { color: C.mut, width: 0.7 });
    y += 11;
    for (const row of rows) {
      ensure(rowH);
      x = ML;
      row.forEach((cell, i) => {
        pdf.text(aligns[i] === 'right' ? x + widths[i] - 2 : x, y, String(cell),
          { size: 8.5, align: aligns[i] || 'left' });
        x += widths[i];
      });
      y += 4;
      pdf.line(ML, y, ML + widths.reduce((s, w) => s + w, 0), y, { color: C.grid, width: 0.4 });
      y += 11;
    }
    y += 6;
  };

  // ── Шапка ──
  pdf.text(ML, y, 'Отчёт эксплуатации автопарка — планер', { size: 15, font: 'B' });
  y += 18;
  pdf.text(ML, y, `Период ${data.from} — ${data.to} (конец не включается) · выручка без НДС по канону`, { size: 8.5, color: C.sec });
  y += 12;
  pdf.text(ML, y, 'наличные как есть, ИП ÷1,07, организации ÷1,22 · линия = живой ряд рейсов и перегонов', { size: 8.5, color: C.sec });
  y += 20;

  // ── Плитки показателей: 3 × 2 ──
  const onP = late.P.n ? Math.round((late.P.n - late.P.late1) / late.P.n * 100) : 100;
  const onD = late.D.n ? Math.round((late.D.n - late.D.late1) / late.D.n * 100) : 100;
  const tiles = [
    ['Выручка без НДС', `${(T.rev / 1e6).toFixed(1)} млн`, `${T.trips} рейсов за ${T.days} дн`],
    ['Техготовность · КТГ', `${(T.fleet - downtime.repair.avg).toFixed(1)} маш`, `КТГ ${T.ktg}% из ${T.fleet} списочных`],
    ['На линии среднесуточно', `${data.avgOnline} маш`, `КВЛ ${T.kvl}% по закрытым рейсам`],
    ['Под грузом · КИП', `${(data.avgOnline * T.kip / 100).toFixed(1)} маш`, `КИП ${T.kip}% времени линии`],
    ['Погрузка вовремя', `${onP}%`, `${late.P.late1} опозд. >1 ч из ${late.P.n}`],
    ['Выгрузка вовремя', `${onD}%`, `${late.D.late1} опозд. >1 ч из ${late.D.n}`]
  ];
  const tw = (MW - 16) / 3, th = 44;
  tiles.forEach((tile, i) => {
    const tx = ML + (i % 3) * (tw + 8), ty = y + Math.floor(i / 3) * (th + 8);
    pdf.rect(tx, ty, tw, th, { fill: C.tile });
    pdf.text(tx + 8, ty + 13, tile[0], { size: 7.5, color: C.sec });
    pdf.text(tx + 8, ty + 28, tile[1], { size: 13, font: 'B' });
    pdf.text(tx + 8, ty + 39, tile[2], { size: 7, color: C.mut });
  });
  y += th * 2 + 8 + 20;

  // ── Секции ──
  h2('КТГ · КВЛ · КИП в динамике, % — по дням');
  chartLines([D.ktg, D.kvl, D.kip], ['КТГ — техготовность', 'КВЛ — выпуск на линию', 'КИП — использование'],
    [C.s1, C.s2, C.s3], D.labels, 100, 2);
  h2('КТГ · КВЛ · КИП — по неделям (пн–вс)');
  chartLines([WK.ktg, WK.kvl, WK.kip], ['КТГ', 'КВЛ', 'КИП'], [C.s1, C.s2, C.s3], WK.labels, 100, 1);

  h2('Простой парка по причинам — среднесуточно машин');
  table(['Причина', 'Машин в сутки', 'Машино-часов за период'],
    Object.values(downtime).map(item => [item.label, item.avg, item.hours]),
    [220, 120, 175], ['left', 'right', 'right']);

  h2('Выручка, млн ₽ без НДС — по дням');
  chartBars(D.rev, D.labels, C.s1, 2);
  h2('Выручка — по неделям');
  chartBars(WK.rev, WK.labels, C.s1, 1);

  h2('Машины на линии по дням');
  chartLines([online], ['на линии'], [C.s1], D.labels, 0, 2);

  h2('Опоздания прибытий: доля >1 ч по дням, %');
  chartLines([late.P.byDayPct, late.D.byDayPct], ['на погрузку', 'на выгрузку'], [C.s1, C.s2], D.labels, 60, 2);
  pdf.text(ML, y, `Медиана опоздания среди опоздавших: погрузка ${late.P.median} ч, выгрузка ${late.D.median} ч; >3 ч: погрузка ${late.P.late3}, выгрузка ${late.D.late3}.`,
    { size: 8, color: C.sec });
  y += 20;

  const lateRows = list => list.slice(0, 8).map(item => [String(item.name).slice(0, 46), item.n, `+${item.avgH} ч`]);
  if (late.D.top.length) {
    h2('Опоздания >1 ч на выгрузку — по клиентам');
    table(['Клиент', 'Опозданий', 'В среднем'], lateRows(late.D.top), [300, 100, 100], ['left', 'right', 'right']);
  }
  if (late.P.top.length) {
    h2('Опоздания >1 ч на погрузку — по клиентам');
    table(['Клиент', 'Опозданий', 'В среднем'], lateRows(late.P.top), [300, 100, 100], ['left', 'right', 'right']);
  }

  h2('Недели: каскад КТГ · КВЛ · КИП');
  table(['Неделя', 'Выручка, млн', 'Рейсов', 'КТГ %', 'КВЛ %', 'КИП %'],
    park.weeks.map(week => [`${week.from.slice(8)}–${week.to.slice(8)}.${week.to.slice(5, 7)}`,
      (week.rev / 1e6).toFixed(1), week.trips, week.ktg, week.kvl, week.kip]),
    [120, 95, 75, 75, 75, 75], ['left', 'right', 'right', 'right', 'right', 'right']);

  h2('Топ клиентов по выручке без НДС');
  table(['Клиент', 'Рейсов', 'Выручка, млн'],
    park.clients.slice(0, 15).map(client => [String(client.name).slice(0, 46), client.n, (client.rev / 1e6).toFixed(1)]),
    [300, 100, 100], ['left', 'right', 'right']);

  return pdf.build();
}
