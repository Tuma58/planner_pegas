// PDF-презентация отчёта «Эксплуатация за период» (заказ руководителя
// 17.11): те же данные opsPeriodData, что и экранный отчёт, свёрстанные
// pdf-lite в альбомные слайды A4 — титул с главными цифрами, ресурс по
// дням, план/факт машино-дней, люди, внештатки. Деньги приходят в data
// уже порезанными по уровню (сервер), здесь только вёрстка.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PdfLite, A4, BRAND } from './pdf-lite.mjs';

const fontsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fonts');
const FONT_R = fs.readFileSync(path.join(fontsDir, 'DejaVuSans.ttf'));
const FONT_B = fs.readFileSync(path.join(fontsDir, 'DejaVuSans-Bold.ttf'));

const W = A4.h, H = A4.w, ML = 56, MR = 56, CW = W - ML - MR;
const teal = '#0f766e';
const fmtDay = iso => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
const fmtFull = iso => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
const rub = value => `${Math.round(Number(value || 0)).toLocaleString('ru-RU')} ₽`;
const WD = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const dayLabel = iso => `${WD[new Date(`${iso}T12:00:00Z`).getUTCDay()]} ${fmtDay(iso)}`;

export function renderOpsPeriodPdf(data) {
  const pdf = new PdfLite({ landscape: true });
  pdf.addFont('R', FONT_R);
  pdf.addFont('B', FONT_B);
  const period = `${fmtFull(data.from)} — ${fmtFull(data.to)}`;
  const pages = data.goals ? 6 : 5;
  let slideNo = 1;
  let y = 0;

  const slideHead = (n, title) => {
    y = 64;
    pdf.logo(ML, y - 30, 30);
    const lx = ML + 44;
    pdf.text(lx, y - 16, 'Пегас-Авто · Эксплуатация', { size: 11, font: 'B', color: teal });
    pdf.text(lx, y + 2, title, { size: 20, font: 'B' });
    pdf.text(W - MR, y - 16, `период ${period}`, { size: 9, color: BRAND.muted, align: 'right' });
    pdf.text(W - MR, H - 24, `${n} / ${pages}`, { size: 8, color: BRAND.muted, align: 'right' });
    y += 16;
    pdf.rect(ML, y, CW, 2.4, { fill: teal });
    y += 26;
  };
  const kpi = (items, { h = 64 } = {}) => {
    const bw = (CW - (items.length - 1) * 12) / items.length;
    items.forEach((item, i) => {
      const x = ML + i * (bw + 12);
      pdf.rect(x, y, bw, h, { stroke: item.hot ? BRAND.neg : BRAND.border, width: item.hot ? 1.4 : 0.8 });
      pdf.text(x + 12, y + 26, String(item.v), { size: 18, font: 'B',
        color: item.hot ? BRAND.neg : (item.good ? BRAND.pos : BRAND.ink) });
      const words = String(item.l).split(' ');
      let line = '', ly = y + 42;
      for (const word of words) {
        const probe = line ? `${line} ${word}` : word;
        if (pdf.width(probe, 8.2, 'R') > bw - 22 && line) {
          pdf.text(x + 12, ly, line, { size: 8.2, color: BRAND.muted }); ly += 10; line = word;
        } else line = probe;
      }
      if (line) pdf.text(x + 12, ly, line, { size: 8.2, color: BRAND.muted });
    });
    y += h + 22;
  };
  const para = (text, { size = 10.5, color = BRAND.ink, lead = 15 } = {}) => {
    const words = String(text).split(' ');
    let line = '';
    for (const word of words) {
      const probe = line ? `${line} ${word}` : word;
      if (pdf.width(probe, size, 'R') > CW && line) {
        pdf.text(ML, y, line, { size, color }); y += lead; line = word;
      } else line = probe;
    }
    if (line) { pdf.text(ML, y, line, { size, color }); y += lead; }
  };
  const bullet = (text, { size = 10.5, lead = 15 } = {}) => {
    pdf.circle(ML + 4, y - 3, 2, { fill: teal });
    const words = String(text).split(' ');
    let line = '';
    for (const word of words) {
      const probe = line ? `${line} ${word}` : word;
      if (pdf.width(probe, size, 'R') > CW - 18 && line) {
        pdf.text(ML + 16, y, line, { size }); y += lead; line = word;
      } else line = probe;
    }
    if (line) { pdf.text(ML + 16, y, line, { size }); y += lead; }
    y += 3;
  };
  const foot = text => pdf.text(ML, H - 24, text, { size: 7.6, color: BRAND.muted });

  const md = data.md;
  // Работа = линия + перегоны (18.11): перегон — часть задания, не потеря.
  const mdWork = md.work ?? (md.sum.line + (md.sum.transfer || 0));
  const planPct = md.plan ? Math.round(mdWork / md.plan * 1000) / 10 : 0;
  const days = data.days;
  const perDay = value => days.length ? Math.round(value / days.length * 10) / 10 : 0;
  const staff = data.staff || {};
  const att = data.attendance || [];
  const attKnown = att.filter(a => a.present != null);
  const presentMin = attKnown.length ? Math.min(...attKnown.map(a => a.present)) : null;
  const presentMax = attKnown.length ? Math.max(...attKnown.map(a => a.present)) : null;
  const unmarkedMax = attKnown.length ? Math.max(...attKnown.map(a => a.unmarked || 0)) : 0;

  // ── Слайд 1 · титул ──
  pdf.page();
  y = 140;
  pdf.logo(ML, y, 44);
  y += 78;
  pdf.text(ML, y, 'Эксплуатация за период', { size: 30, font: 'B' });
  y += 26;
  pdf.text(ML, y, period, { size: 15, color: BRAND.muted });
  y += 14;
  pdf.rect(ML, y, 240, 2.4, { fill: teal });
  y += 44;
  kpi([
    { v: `${mdWork} из ${md.plan}`, l: `машино-дней в работе (линия${md.sum.transfer ? ' + перегоны' : ''}) — ${String(planPct).replace('.', ',')}% рабочего фонда` },
    { v: md.lost, l: data.money ? `потеряно машино-дней ≈ ${rub(data.money.lost)}` : 'потеряно машино-дней', hot: md.lost > 0 },
    { v: staff.headcount ?? '—', l: `водителей в штате · принято ${staff.hired ?? '—'} · уволено ${staff.fired ?? '—'}` },
    { v: staff.turnoverPct != null ? `${String(staff.turnoverPct).replace('.', ',')} %` : '—',
      l: `текучесть периода${data.turnover?.targetPct != null ? ` при цели ${data.turnover.targetPct}%/мес` : ''}`,
      hot: staff.turnoverPct != null && data.turnover?.targetPct != null && staff.turnoverPct > data.turnover.targetPct }
  ], { h: 72 });
  foot('Цифры — канон планера: resourceDayData по дням · attendanceSummary · driverTurnover за период · incidentsSummary');

  // ── Слайд · против целей отдела (когда цели есть в «Целях и задачах») ──
  if (data.goals) {
    pdf.page();
    slideHead(++slideNo, 'Против целей отдела');
    const toneColor = { ok: BRAND.pos, near: BRAND.warn, miss: BRAND.neg };
    const toneLabel = { ok: 'в цели', near: 'рядом', miss: 'мимо', info: 'справочно', none: 'нет данных' };
    for (const item of data.goals.items.slice(0, 7)) {
      const m = item.metric || {};
      const color = toneColor[m.tone] || BRAND.muted;
      pdf.circle(ML + 5, y - 4, 4, { fill: color });
      pdf.text(ML + 18, y, `${item.kind === 'dept' ? 'ЦЕЛЬ ОТДЕЛА: ' : ''}${item.title}`, { size: 11.5, font: item.kind === 'dept' ? 'B' : 'R' });
      const valueText = m.value != null ? `${String(m.value).replace('.', ',')}${m.unit ? ` ${m.unit}` : ''}` : '—';
      const targetText = m.target != null ? ` / цель ${String(m.target).replace('.', ',')}` : '';
      pdf.text(W - MR, y, `${valueText}${targetText} · ${toneLabel[m.tone] || '—'}`,
        { size: 11.5, font: 'B', align: 'right', color });
      y += 10;
      pdf.text(ML + 18, y, m.label || '', { size: 8.5, color: BRAND.muted });
      y += 20;
    }
    y += 6;
    para(`Каскад за период (канон «Сводного отчёта»): КТГ ${data.goals.cascade.ktg ?? '—'} · КВЛ ${data.goals.cascade.kvl ?? '—'} · КИП ${data.goals.cascade.kip ?? '—'} · КЭИП ${data.goals.cascade.keip ?? '—'}. Узкие места каскада видны по первым красным ступеням.`, { size: 10, color: BRAND.muted });
    foot('Источник: «Цели и задачи» отдела эксплуатации · живые метрики evalMetric за период отчёта');
  }

  // ── Слайд · ресурс по дням ──
  pdf.page();
  slideHead(++slideNo, 'Ресурс парка по дням');
  // До 16 дней — бары по дням; длиннее — агрегация по неделям (среднее).
  let bars = days.map(d => ({ label: dayLabel(d.day), line: d.counters.line }));
  let barNote = 'Машин на линии в день';
  if (bars.length > 16) {
    const weeks = [];
    for (let i = 0; i < days.length; i += 7) {
      const chunk = days.slice(i, i + 7);
      weeks.push({ label: `${fmtDay(chunk[0].day)}–${fmtDay(chunk[chunk.length - 1].day)}`,
        line: Math.round(chunk.reduce((sum, d) => sum + d.counters.line, 0) / chunk.length) });
    }
    bars = weeks;
    barNote = 'Машин на линии, среднее за неделю';
  }
  const chartY = y + 150, chartH = 118;
  const slot = CW / bars.length;
  const bw = Math.min(64, slot - 10);
  const lineMax = Math.max(...bars.map(b => b.line), 1);
  const lineMin = Math.min(...bars.map(b => b.line));
  const base = Math.max(0, lineMin - Math.max(4, Math.round((lineMax - lineMin) * 0.4)));
  bars.forEach((bar, i) => {
    const x = ML + i * slot + (slot - bw) / 2;
    const h = Math.max(6, ((bar.line - base) / Math.max(1, lineMax - base)) * chartH);
    const best = bar.line === lineMax;
    pdf.rect(x, chartY - h, bw, h, { fill: best ? BRAND.pos : teal });
    pdf.text(x + bw / 2, chartY - h - 8, String(bar.line), { size: bars.length > 10 ? 9 : 12, font: 'B', align: 'center' });
    pdf.text(x + bw / 2, chartY + 15, bar.label, { size: bars.length > 10 ? 7 : 9.5, color: BRAND.muted, align: 'center' });
  });
  pdf.text(ML, chartY - chartH - 26, barNote, { size: 10, color: BRAND.muted });
  y = chartY + 42;
  const first = days[0].counters, last = days[days.length - 1].counters;
  para(`Начало → конец периода: на линии ${first.line} → ${last.line}, в ремонте ${first.repair} → ${last.repair}, без экипажа ${first.no_driver} → ${last.no_driver}, простой без оформления ${first.idle} → ${last.idle}. Пересменок за период ${md.sum.shift} машино-дней.`);
  foot('Источник: отчёт «Ресурс за день» по каждому дню · сумма категорий = парк, расхождений нет');

  // ── Слайд · план/факт машино-дней ──
  pdf.page();
  slideHead(++slideNo, 'План / факт машино-дней');
  kpi([
    { v: md.plan, l: 'план: рабочий парк каждого дня периода' },
    { v: mdWork, l: `в работе = ${String(planPct).replace('.', ',')}% фонда (линия ${md.sum.line}${md.sum.transfer ? ` + перегоны ${md.sum.transfer}` : ''})` },
    { v: md.lost, l: 'потеряно машино-дней', hot: md.lost > 0 },
    data.money
      ? { v: `≈ ${rub(data.money.lost)}`, l: `цена потерь по факту периода (${rub(data.money.perLineDay)}/машино-день линии)`, hot: md.lost > 0 }
      : { v: md.sum.repair, l: 'из них в ремонте' }
  ]);
  const parts = [
    [`Ремонт · ${md.sum.repair}`, md.sum.repair, BRAND.neg],
    [`Без экипажа · ${md.sum.no_driver}`, md.sum.no_driver, BRAND.warn],
    [`Простой · ${md.sum.idle}`, md.sum.idle, '#8a8fa3'],
    [`Пересменки · ${md.sum.shift}`, md.sum.shift, teal]
  ].filter(([, v]) => v > 0);
  const lostTotal = parts.reduce((sum, [, v]) => sum + v, 0);
  if (lostTotal > 0) {
    const lossY = y + 8, lossH = 34;
    let px = ML;
    const narrow = [];
    for (const [label, v, color] of parts) {
      const w = (v / lostTotal) * CW;
      pdf.rect(px, lossY, Math.max(2, w - 2), lossH, { fill: color });
      if (w > 86) pdf.text(px + 8, lossY + 21, label, { size: 9.5, font: 'B', color: '#ffffff' });
      else narrow.push(label);
      px += w;
    }
    // Узкие сегменты — одной строкой под полосой, чтобы подписи не слипались.
    if (narrow.length) pdf.text(W - MR, lossY + lossH + 14, narrow.join('   ·   '), { size: 8.5, color: BRAND.muted, align: 'right' });
    y = lossY + lossH + 36;
  }
  bullet(`Ремонт ~${String(perDay(md.sum.repair)).replace('.', ',')} машин в день — вопрос ТОиР: очередь нарядов и запчасти;`);
  bullet(`Без экипажа ~${String(perDay(md.sum.no_driver)).replace('.', ',')} в день — вопрос найма${data.staffing != null && data.staffingTarget ? `: укомплектованность ${String(Math.round(data.staffing * 100) / 100).replace('.', ',')} при цели ${String(data.staffingTarget).replace('.', ',')}` : ''};`);
  bullet(`Простой без оформления ~${String(perDay(md.sum.idle)).replace('.', ',')} в день — вопрос логистики: машина подана, задания нет.`);
  foot(`Раскладка сходится до машино-дня: ${mdWork} в работе (линия + перегоны) + потери и выведенные = календарь парка`);

  // ── Слайд · люди ──
  pdf.page();
  slideHead(++slideNo, 'Люди: явка, штат, текучесть');
  kpi([
    { v: presentMin != null ? `${presentMin}–${presentMax}` : '—', l: `явка водителей в день (в штате ${staff.headcount ?? '—'})` },
    { v: staff.sickDays ?? 0, l: 'больничных человеко-дней за период' },
    { v: unmarkedMax, l: 'не отмечено в табеле в худший день', hot: unmarkedMax > 10 },
    { v: `${staff.hired ?? '—'} / ${staff.fired ?? '—'}`, l: 'принято / уволено за период',
      hot: Number(staff.fired) > Number(staff.hired) }
  ]);
  for (const m of (data.turnover?.byMonth || []).slice(0, 4)) {
    const over = data.turnover?.targetPct != null && m.turnoverPct > data.turnover.targetPct;
    bullet(`${m.month}: нанято ${m.hired}, уволено ${m.fired}, текучесть ${String(m.turnoverPct).replace('.', ',')}%${over ? ' — выше цели' : ''};`);
  }
  const shortTenure = (data.turnover?.recentFired || []).filter(f => f.tenureDays != null && f.tenureDays < 90);
  if (shortTenure.length) {
    bullet(`Уволенные со стажем до 90 дней: ${shortTenure.slice(0, 5).map(f => `${f.name} (${f.tenureDays} дн)`).join(', ')}${shortTenure.length > 5 ? '…' : ''} — каждый такой уход разбирать персонально.`);
  }
  foot('Источники: табель (attendanceSummary) · текучесть (driverTurnover за период отчёта)');

  // ── Слайд · внештатки ──
  pdf.page();
  slideHead(++slideNo, 'Внештатные ситуации');
  const inc = data.incidents || { counts: { act: 0, return: 0, late: 0 }, returnsClosed: 0, openReturns: [], autoLate: 0 };
  kpi([
    { v: inc.counts.act, l: 'актов на выгрузке за период' },
    { v: inc.counts.return, l: `возвратов · закрыто ${inc.returnsClosed}`, good: inc.counts.return > 0 && inc.returnsClosed >= inc.counts.return },
    { v: inc.openReturns.length, l: 'возвратов открыто сейчас', hot: inc.openReturns.length > 0 },
    { v: inc.autoLate, l: `опозданий >1 ч по отметкам (ручных ${inc.counts.late})` }
  ]);
  if (inc.openReturns.length) {
    pdf.text(ML, y, 'Открытые возвраты — ждут решения:', { size: 11, font: 'B' });
    y += 20;
    const cols = [0, 130, 420, 620];
    const header = ['Борт', 'Клиент', 'Что и где', 'Возраст'];
    header.forEach((t, i) => pdf.text(ML + cols[i], y, t, { size: 8.5, font: 'B', color: BRAND.muted }));
    y += 6;
    pdf.line(ML, y, W - MR, y, { color: BRAND.border });
    y += 13;
    for (const r of inc.openReturns.slice(0, 7)) {
      pdf.text(ML + cols[0], y, r.plate, { size: 10.5, font: 'B' });
      pdf.text(ML + cols[1], y, String(r.customer_name || '').slice(0, 44), { size: 10.5 });
      pdf.text(ML + cols[2], y, `${String(r.qty || '').slice(0, 18)}${r.warehouse ? ` · ${String(r.warehouse).slice(0, 30)}` : ' · на борту'}`, { size: 10.5 });
      pdf.text(ML + cols[3], y, `${String(r.age_days).replace('.', ',')} сут`, { size: 10.5, font: r.age_days > 3 ? 'B' : 'R', color: r.age_days > 3 ? BRAND.neg : BRAND.ink });
      y += 18;
    }
  } else {
    para('Открытых возвратов нет.');
  }
  foot('Источник: вкладка «Внештатки» (incidentsSummary) · порог авто-опоздания 1 ч — тот же, что в отчётах');

  return pdf.build();
}
