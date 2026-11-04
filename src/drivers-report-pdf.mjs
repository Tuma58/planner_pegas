// PDF-версия отчёта «Водители: профиль и дисциплина» (заказ 25.09):
// те же данные driverPeriodMetrics, что и экранная таблица, свёрстанные
// pdf-lite в многостраничный A4. Светофор — цветной маркер + балл.
// Оформление — светлая подача бренд-платформы «Пегас-Авто» (BRAND).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PdfLite, A4, BRAND } from './pdf-lite.mjs';

const fontsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fonts');
const FONT_R = fs.readFileSync(path.join(fontsDir, 'DejaVuSans.ttf'));
const FONT_B = fs.readFileSync(path.join(fontsDir, 'DejaVuSans-Bold.ttf'));

const C = { ink: BRAND.ink, sec: BRAND.muted, mut: BRAND.faint, grid: BRAND.border2,
  tile: BRAND.thBg, green: BRAND.pos, yellow: BRAND.warn, red: BRAND.neg, none: BRAND.faint };
const ML = 40, MR = 40, MW = A4.w - ML - MR;

const fmtDay = iso => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;

export function renderDriversReportPdf({ from, to, drivers, park }) {
  const pdf = new PdfLite();
  pdf.addFont('R', FONT_R);
  pdf.addFont('B', FONT_B);
  pdf.page();
  let y = 52;

  // Шапка: полоса ультрамарина, знак на белой подложке, словесный знак.
  pdf.rect(0, 0, A4.w, 78, { fill: BRAND.u800 });
  pdf.rect(ML, 16, 74, 46, { fill: '#ffffff' });
  pdf.logo(ML + 7, 20, 38);
  pdf.text(ML + 88, 33, 'Пегас-Авто', { size: 9, font: 'B', color: BRAND.u200 });
  pdf.text(ML + 88, 53, 'Водители: профиль и дисциплина', { size: 16, font: 'B', color: '#ffffff' });
  pdf.text(ML + MW, 33, 'Пегас-Авто · Планер', { size: 7.5, color: BRAND.u300, align: 'right' });
  y = 100;
  pdf.text(ML, y, `Период ${fmtDay(from)} — ${fmtDay(to)} (конец не включается) · Пегас-Авто · Планер`, { size: 8.5, color: C.sec });
  y += 12;
  pdf.text(ML, y, `Медианы парка: рейс целиком ${park.ve ?? '—'} км/ч · в движении ${park.vt ?? '—'} км/ч · ворота выгрузки ${park.gateUnloadH ?? '—'} ч · КИП ${park.kip ?? '—'}%`, { size: 8.5, color: C.sec });
  y += 12;
  pdf.text(ML, y, 'Оценка: 100 − отставание скорости от парка (до 40) − опоздания П (до 30) − опоздания В (до 15) − рваные отметки (до 15).', { size: 8, color: C.mut });
  y += 10;
  const legend = [[C.green, '80+ норма'], [C.yellow, '60–79 внимание'], [C.red, 'до 60 разбор'], [C.none, 'меньше 3 рейсов']];
  let lx = ML;
  for (const [color, label] of legend) {
    pdf.rect(lx, y - 6, 7, 7, { fill: color });
    lx += 10;
    lx += pdf.text(lx, y, label, { size: 8, color: C.sec }) + 14;
  }
  y += 16;

  // Колонки: маркер+балл · водитель · рейсы · км · Vэ · Vт · оп.П · оп.В · ворота · отметки
  const cols = [
    { w: 34, label: 'Балл', align: 'left' },
    { w: 130, label: 'Водитель', align: 'left' },
    { w: 34, label: 'Рейсы', align: 'right' },
    { w: 46, label: 'км', align: 'right' },
    { w: 40, label: 'Vэ, км/ч', align: 'right' },
    { w: 40, label: 'Vт, км/ч', align: 'right' },
    { w: 38, label: 'КИП', align: 'right' },
    { w: 40, label: 'Оп. П', align: 'right' },
    { w: 40, label: 'Оп. В', align: 'right' },
    { w: 45, label: 'Ворота, ч', align: 'right' },
    { w: 45, label: 'Отметки', align: 'right' }
  ];
  const xs = [];
  let acc = ML;
  for (const col of cols) { xs.push(acc); acc += col.w; }
  const cellX = i => cols[i].align === 'right' ? xs[i] + cols[i].w - 2 : xs[i];

  const head = () => {
    // Плашка во всю ширину колонок (их сумма чуть шире поля) — белый текст
    // шапки не должен сойти на белое.
    pdf.rect(ML, y - 9, Math.max(MW, acc - ML), 13, { fill: C.tile });
    cols.forEach((col, i) => pdf.text(cellX(i) + (col.align === 'right' ? 0 : 2), y, col.label,
      { size: 7.5, font: 'B', color: '#ffffff', align: col.align }));
    y += 8;
    pdf.line(ML, y, ML + MW, y, { color: C.grid });
    y += 9;
  };
  head();
  // Страница продолжения: тонкая фирменная полоса и колонтитул.
  function nextPage() {
    pdf.page();
    pdf.rect(0, 0, A4.w, 4, { fill: BRAND.u800 });
    pdf.text(ML, 24, 'Пегас-Авто · Водители: профиль и дисциплина', { size: 7.5, font: 'B', color: BRAND.accent });
    pdf.text(ML + MW, 24, `${fmtDay(from)} — ${fmtDay(to)}`, { size: 7.5, color: C.mut, align: 'right' });
  }

  const lightColor = light => C[light] || C.none;
  for (const d of drivers) {
    if (y > A4.h - 50) { nextPage(); y = 52; head(); }
    pdf.rect(xs[0], y - 6.5, 7, 7, { fill: lightColor(d.light) });
    pdf.text(xs[0] + 10, y, d.score == null ? '—' : String(d.score), { size: 8, font: 'B' });
    pdf.text(xs[1], y, d.name.slice(0, 30) + (d.vehicles > 1 ? ` ×${d.vehicles}` : ''), { size: 8 });
    const cells = [
      String(d.trips), d.km.toLocaleString('ru-RU'),
      d.ve == null ? '—' : d.ve.toFixed(1), d.vt == null ? '—' : d.vt.toFixed(1),
      d.kip == null ? '—' : `${d.kip}%`,
      d.loadFacts ? `${d.lateLoad}/${d.loadFacts}` : '—',
      d.unloadFacts ? `${d.lateUnload}/${d.unloadFacts}` : '—',
      d.gateUnloadH == null ? '—' : d.gateUnloadH.toFixed(1),
      d.cleanPct == null ? '—' : `${d.cleanPct}%`
    ];
    cells.forEach((value, i) => {
      const idx = i + 2;
      const alert = (idx === 4 && d.ve != null && park.ve && d.ve < park.ve * 0.8) ||
        (idx === 6 && d.kip != null && park.kip && d.kip < park.kip * 0.8) ||
        (idx === 7 && d.loadFacts && d.lateLoad / d.loadFacts > 0.3) ||
        (idx === 10 && d.cleanPct != null && d.cleanPct < 70);
      pdf.text(cellX(idx), y, value, { size: 8, align: 'right', color: alert ? C.red : C.ink });
    });
    y += 4;
    pdf.line(ML, y, ML + MW, y, { color: C.grid, width: 0.4 });
    y += 9;
  }

  if (y > A4.h - 60) { nextPage(); y = 52; }
  y += 4;
  pdf.text(ML, y, 'Как читать: Vэ ниже парковой на 20%+ (красным) — водитель много стоит; если Vт нормальная — вопрос к организации,', { size: 7.5, color: C.mut });
  y += 9;
  pdf.text(ML, y, 'не к манере езды. КИП — работа в рейсах (дорога + норматив ворот) от нормы рабочего времени, канон отчёта парка.', { size: 7.5, color: C.mut });
  y += 9;
  pdf.text(ML, y, 'Ворота выгрузки — время клиента, в балл не входят. Отметки — доля рейсов с чистой цепочкой фактов.', { size: 7.5, color: C.mut });
  return pdf.build();
}
