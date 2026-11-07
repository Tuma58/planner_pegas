// Секция «Текучесть водителей» (KPI паспорта руководителя эксплуатации,
// чек-лист Б1.3, 07.11.2026). Чистая функция: данные GET /api/turnover →
// HTML-строка секции BI-набора (bi/kit.css). Всё считает сервер
// (src/turnover.mjs), секция только показывает. Вставляется в поле
// управления Эксплуатации и в KPI.
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const ruDay = iso => String(iso || '').split('-').reverse().join('.');
const num = value => Number(value || 0).toLocaleString('ru-RU', { maximumFractionDigits: 1 });
const pct = value => (value === null || value === undefined ? '—' : `${num(value)}<small>%</small>`);
const MONTHS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const monthLabel = ym => `${MONTHS[Number(String(ym).slice(5, 7)) - 1] || ym} ${String(ym).slice(2, 4)}`;
const tenure = row => (row.tenureDays === null || row.tenureDays === undefined ? '—'
  : `${row.tenureKnown ? '' : '≥ '}${row.tenureDays} дн`);
const THRESHOLD_SOURCE = { settings: 'из Настроек', learned: 'медиана стажа уволенных', none: 'не определён' };

export function turnoverSection(data) {
  if (!data || data.error) {
    return `<section class="section dept-drv tv-section"><div class="sec-h"><span class="st">Текучесть водителей</span></div>
      <div class="bi-empty">${esc(data?.error || 'Нет данных')}</div></section>`;
  }
  const target = data.targetPct;
  const tone = target === null || target === undefined || data.turnoverPct === null ? ''
    : data.turnoverPct > target ? 'neg' : 'pos';
  const th = data.threshold || {};
  const months = (data.byMonth || []).map(m => `<tr>
      <td>${esc(monthLabel(m.month))}${m.days < 28 ? ` <span class="muted">${ruDay(m.from).slice(0, 5)}–${ruDay(m.to).slice(0, 5)}</span>` : ''}</td>
      <td class="num">${num(m.headcountAvg)}</td><td class="num">${m.hired}</td><td class="num">${m.fired}</td>
      <td class="num"><b>${m.turnoverPct === null ? '—' : `${num(m.turnoverPct)}%`}</b></td></tr>`).join('');
  const shortIds = new Set((data.shortTenure || []).map(row => row.id));
  const fired = (data.recentFired || []).map(row => `<tr data-driver="${esc(row.id)}">
      <td><b>${esc(row.name)}</b>${shortIds.has(row.id) ? ' <span class="bi-tag warn">короткий стаж</span>' : ''}
        ${row.reason ? `<div class="muted">${esc(row.reason)}</div>` : ''}</td>
      <td class="num">${ruDay(row.firedOn)}</td>
      <td class="num" title="${row.tenureKnown ? `принят ${ruDay(row.hiredOn)}` : 'в штате до начала учёта — точный стаж неизвестен'}">${tenure(row)}</td></tr>`).join('');
  const excluded = data.excludedFired || [];
  const notes = [
    data.note,
    th.days === null || th.days === undefined
      ? `порог короткого стажа не определён${th.note ? ` (${th.note})` : ''}`
      : `короткий стаж — меньше ${th.days} дн (${THRESHOLD_SOURCE[th.source] || th.source}${th.source === 'learned' ? `, ${th.samples} обр.` : ''})`,
    excluded.length ? `не считаются увольнением: ${excluded.length} (дубли записей и записи без работы)` : ''
  ].filter(Boolean);
  return `<section class="section dept-drv tv-section">
    <div class="sec-h"><span class="st">Текучесть водителей</span>
      <span class="hint">${ruDay(data.coverageFrom || data.from)}–${ruDay(data.to)} · уволено / средняя численность × 100</span></div>
    <div class="sec-b">
      <div class="bi-kpis">
        <div class="metric hero ${tone}"><span class="l">Текучесть</span><span class="v">${pct(data.turnoverPct)}</span>
          <span class="d">${target === null || target === undefined ? 'цель не задана' : `цель ≤ ${num(target)}% в месяц`}</span></div>
        <div class="metric dept-drv"><span class="l">Средняя численность</span><span class="v">${num(data.headcountAvg)}</span>
          <span class="d">сейчас в штате ${data.active ?? '—'}</span></div>
        <div class="metric"><span class="l">Принято</span><span class="v">${data.hired ?? 0}</span><span class="d">за период</span></div>
        <div class="metric ${data.fired ? 'warn' : ''}"><span class="l">Уволено</span><span class="v">${data.fired ?? 0}</span>
          <span class="d">без дублей записей</span></div>
        <div class="metric ${(data.shortTenure || []).length ? 'warn' : ''}"><span class="l">Короткий стаж</span>
          <span class="v">${(data.shortTenure || []).length}</span>
          <span class="d">${data.shortTenureShare === null || data.shortTenureShare === undefined ? '—' : `${num(data.shortTenureShare)}% уволенных`}</span></div>
      </div>
    </div>
    <div class="sec-b flush">${months ? `<table class="bi-table"><thead><tr><th>Месяц</th><th class="r">Ср. численность</th>
      <th class="r">Принято</th><th class="r">Уволено</th><th class="r">Текучесть</th></tr></thead><tbody>${months}</tbody></table>`
      : '<div class="bi-empty">Нет данных за период</div>'}</div>
    <div class="sec-b flush">${fired ? `<div class="bi-scroll"><table class="bi-table"><thead><tr><th>Уволены за период</th>
      <th class="r">Дата</th><th class="r">Стаж</th></tr></thead><tbody>${fired}</tbody></table></div>`
      : '<div class="bi-empty">Увольнений за период нет</div>'}</div>
    ${notes.length ? `<div class="sec-b muted tv-notes">${notes.map(esc).join(' · ')}</div>` : ''}
  </section>`;
}
