// ЦФО — центры финансовой ответственности (проект «Слияние», блок 3,
// решения руководителя 07.11.2026). Статья журнала затрат принадлежит
// ЦФО (expense_categories.cfo): Эксплуатация и ТОиР — центры затрат,
// Логистика — центр дохода/маржи, Направление (Штаб) — свод и общие
// статьи. Здесь нет своих формул денег и машино-дней: факт затрат —
// expensesSummary журнала, выручка/маржа/порожний пробег — сводный
// снимок reportSnapshot (денежный канон money.mjs), машино-дни — его же
// разбивка, претензии за простой — действующий контур demurrage_claims,
// внештатки — trip_incidents. Второй KPI отдела — ЦФО на машино-день:
// ТОиР — ₽ на МД готовности, Эксплуатация — ₽ на МД на линии,
// Логистика — выручка и маржа на МД под грузом.

import { CFO_KEYS, expensesSummary } from './expenses.mjs';

export const CFO_META = {
  drv: { name: 'Отдел эксплуатации', coef: 'КВЛ', cls: 'центр затрат' },
  toir: { name: 'Ремонтная служба (ТОиР)', coef: 'КТГ', cls: 'центр затрат' },
  log: { name: 'Отдел логистики', coef: 'КИП · КЭИП', cls: 'центр дохода / маржи' },
  staff: { name: 'Направление (Штаб)', coef: 'КЭИП', cls: 'центр прибыли · свод' }
};

// Кто что видит (решение 07.11): общий ЦФО — у кого персональный доступ
// к затратам или должность с отметкой «весь ЦФО» (руководитель
// направления); руководитель отдела (должность с отметкой «ЦФО отдела»)
// — только свой отдел. Остальным экран не показывается.
export function cfoScope(db, user, hasExpensesAccess) {
  if (hasExpensesAccess) return { all: true, depts: [...CFO_KEYS] };
  if (!user?.position_id) return null;
  const position = db.prepare(`SELECT dept_key, cfo_view FROM org_positions
    WHERE id=? AND archived_at IS NULL`).get(user.position_id);
  if (!position?.cfo_view) return null;
  if (position.cfo_view === 'all') return { all: true, depts: [...CFO_KEYS] };
  return { all: false, depts: [position.dept_key] };
}

const perMd = (sum, days) => days > 0 ? Math.round(sum / days) : null;

// ctx: { from, to, items (журнал за период), categories (Map), vatRate,
//   snap (reportSnapshot), owners ({dept: [{title, people}]}),
//   demurrage ({billed, open}), incidents ({act, return, late}) }
export function cfoData(ctx, scope) {
  const summary = expensesSummary(ctx.items, ctx.vatRate, ctx.categories);
  const md = ctx.snap?.utilization || {};
  const mdOf = { toir: md.techDays || 0, drv: md.lineDays || 0, log: md.workDays || 0, staff: md.calendarDays || 0 };
  const byCategory = new Map(summary.byCategory.map(row => [row.key, row]));
  const active = [...ctx.categories.values()].filter(category => category.active);
  const centers = CFO_KEYS.filter(key => scope.depts.includes(key)).map(key => {
    const articles = active.filter(category => (category.cfo || 'staff') === key)
      .map(category => {
        const row = byCategory.get(category.id);
        return { id: category.id, name: category.name, kind: category.kind,
          net: row?.net || 0, count: row?.count || 0,
          detail: (summary.byDetail[category.id] || []).length > 1 || /штраф/i.test(category.name)
            ? summary.byDetail[category.id] || [] : [] };
      })
      .sort((a, b) => b.net - a.net);
    const net = articles.reduce((sum, item) => sum + item.net, 0);
    const center = { key, ...CFO_META[key], owners: ctx.owners?.[key] || [],
      articles, net, filled: articles.filter(item => item.count).length, md: mdOf[key] || 0,
      perMd: perMd(net, mdOf[key]) };
    if (key === 'log') {
      const revenue = ctx.snap?.netRevenue || 0;
      const margin = ctx.snap?.contribution || 0;
      center.result = {
        revenue, margin, workDays: md.workDays || 0,
        revenuePerMd: perMd(revenue, md.workDays), marginPerMd: perMd(margin, md.workDays),
        ratePerKm: ctx.snap?.loadedKm ? Math.round(revenue / ctx.snap.loadedKm) : null
      };
      center.losses = {
        emptyKm: ctx.snap?.emptyKm ?? null, emptyCost: ctx.snap?.emptyCost ?? null,
        demurrageBilled: ctx.demurrage?.billed ?? 0, demurrageOpen: ctx.demurrage?.open ?? 0,
        incidents: ctx.incidents || null
      };
    }
    return center;
  });
  const result = { from: ctx.from, to: ctx.to, scope, centers };
  if (scope.all) {
    const revenue = ctx.snap?.netRevenue || 0;
    result.total = {
      revenue, costs: summary.totalNet, profit: revenue - summary.totalNet,
      byCfo: summary.byCfo,
      // Нормативная оценка рядом с фактом — видно, где журнал ещё пуст.
      normative: ctx.snap ? { contribution: ctx.snap.contribution, fixed: ctx.snap.fixed,
        operationalProfit: ctx.snap.operationalProfit } : null,
      coverage: { filled: centers.reduce((sum, c) => sum + c.filled, 0),
        total: centers.reduce((sum, c) => sum + c.articles.length, 0) }
    };
  }
  return result;
}
