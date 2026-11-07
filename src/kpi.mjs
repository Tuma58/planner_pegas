// KPI и каскад (проект «Слияние», блок 4, 07.11.2026). У отдела два KPI
// («Рабочая среда СТ»): основной — машино-дни своего этапа (коэффициент
// против цели), второй — ЦФО на машино-день; плюс сквозной контроль
// соседа «мерим бдительность» (журнал сигналов на стыках). Вес «свой /
// контроль» — настройка (kpiOwnSharePct, по умолчанию 75 — середина
// коридора среды 70–80 / 20–30). Индекс KPI — ориентир для блока «ФОТ»,
// а не готовая премия. Своих формул денег и коэффициентов нет: значения
// приходят готовыми из канонов (parkReportData, ЦФО, signalKpi).

export const KPI_DEPTS = {
  log: { coef: 'КИП', key: 'kip', control: 'log_toir', owns: 'drv_log', name: 'Отдел логистики' },
  drv: { coef: 'КВЛ', key: 'kvl', control: 'drv_log', owns: 'toir_drv', name: 'Отдел эксплуатации' },
  toir: { coef: 'КТГ', key: 'ktg', control: 'toir_drv', owns: 'log_toir', name: 'Ремонтная служба (ТОиР)' }
};

// Привязка строк KPI паспорта (по номеру должности n и порядку строки)
// к живым показателям. Руководители отделов: 0 — основной, 1 — второй
// (ЦФО), 2 — сквозной контроль. Группы логистики — личные показатели
// «Показателей сотрудников» / «Моей смены»; водитель — Ресурс; прочие —
// оценка руководителя (ручная отметка — в блоке «ФОТ»).
const HEADS = { 5: 'log', 9: 'drv', 14: 'toir' };
export function kpiBinding(n, index) {
  if (HEADS[n]) return ['main', 'second', 'control'][index] || 'manual';
  if (n === 1) return index === 0 || index === 1 ? 'keip' : 'manual';
  if ([6, 7, 8].includes(n)) return 'personal';
  if (n === 13) return 'driver';
  return 'manual';
}

const share = (value, target) => value == null || !target ? null : Math.min(100, value / target * 100);

// ctx: { dept, park (total), snap, targets, cfoCenter, signals: {key → signalKpi}, ownPct, positions }
export function kpiDept(ctx) {
  const meta = KPI_DEPTS[ctx.dept];
  const value = ctx.park?.[meta.key] ?? null;
  const target = ctx.targets?.[meta.coef] ?? null;
  const md = ctx.snap?.utilization?.machineDays || {};
  const lost = ctx.dept === 'log' ? md.idle || 0 : ctx.dept === 'drv' ? (md.noDriver || 0) + (md.shift || 0) : md.repair || 0;
  const control = ctx.signals?.[meta.control] || null;
  const owns = ctx.signals?.[meta.owns] || null;
  const ownPct = Number.isFinite(ctx.ownPct) ? ctx.ownPct : 75;
  const ownScore = share(value, target);
  const controlScore = control?.cases ? control.onTimePct : null;
  const index = ownScore == null ? null
    : controlScore == null ? Math.round(ownScore)
      : Math.round(ownScore * ownPct / 100 + controlScore * (100 - ownPct) / 100);
  const second = ctx.cfoCenter
    ? (ctx.cfoCenter.result
      ? { label: 'Выручка на МД под грузом', value: ctx.cfoCenter.result.revenuePerMd, unit: '₽', extra: `маржа ${ctx.cfoCenter.result.marginPerMd ?? '—'} ₽/МД` }
      : { label: 'Затраты ЦФО на МД', value: ctx.cfoCenter.perMd, unit: '₽', extra: `статей наполнено ${ctx.cfoCenter.filled}/${ctx.cfoCenter.articles.length}` })
    : null;
  return {
    dept: ctx.dept, name: meta.name, coef: meta.coef, ownPct,
    main: { value, target, lostMd: Math.round(lost), score: ownScore == null ? null : Math.round(ownScore) },
    second,
    control: control ? { joint: meta.control, ...control } : { joint: meta.control, pending: !ctx.signals },
    owns: owns ? { joint: meta.owns, ...owns } : { joint: meta.owns, pending: !ctx.signals },
    index,
    positions: (ctx.positions || []).map(position => ({
      n: position.n, title: position.title,
      kpi: (position.passport?.kpi || []).map((row, i) => {
        const [title, norm, period] = Array.isArray(row) ? row : [row, '', ''];
        const bind = kpiBinding(position.n, i);
        const live = bind === 'main' ? (value == null ? null : `${value}% / цель ${target}%`)
          : bind === 'second' ? (second?.value == null ? null : `${Math.round(second.value).toLocaleString('ru-RU')} ₽ на МД`)
            : bind === 'control' ? (control?.cases ? `сигналов вовремя ${control.onTimePct}%` : null)
              : null;
        return { title, norm, period, bind, live };
      })
    }))
  };
}
