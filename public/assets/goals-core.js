// Реестр целей направления СТ (проект «Слияние», блок 2, решения
// руководителя 07.11.2026): ОДНА точка правды для целей, общая для
// сервера и экранов. Цели задаёт руководитель в «⚙ Настройки → Цели
// направления»; пустота → канон «Рабочей среды СТ», ноль — осознанное
// значение (принцип 2 концепции живых нормативов).
// Цель использования парка — ПРОИЗВОДНАЯ: КТГ × КВЛ × КИП (решение 07.11
// «заменяем 0,951 произведением»), отдельной цифры больше нет.
// 175 млн — стратегическая цель месяца, помесячный план (revenue_plans)
// — ступень к ней; пробег — 500 км/сут (решение 07.11).

export const GOAL_DEFAULTS = {
  ktgTargetPct: 97, kvlTargetPct: 99, kipTargetPct: 99,
  goalRevenueMln: 175, dailyKmTarget: 500, fleetTarget: 128, fotNormPct: null,
  // Блок 4 «KPI и каскад»: вес своего KPI (остальное — контроль соседа,
  // коридор среды 70–80 / 20–30) и цель «сигнал вовремя», часов.
  kpiOwnSharePct: 75, signalTargetHours: 2,
  // КПП (07.11): подсвечивать личный транспорт на стоянке дольше, ч.
  gateLongHours: 24
};

const pick = (value, fallback) =>
  value === '' || value == null || !Number.isFinite(Number(value)) ? fallback : Number(value);

export function directionGoals(calculation = {}) {
  const c = calculation || {};
  const ktg = pick(c.ktgTargetPct, GOAL_DEFAULTS.ktgTargetPct);
  const kvl = pick(c.kvlTargetPct, GOAL_DEFAULTS.kvlTargetPct);
  const kip = pick(c.kipTargetPct, GOAL_DEFAULTS.kipTargetPct);
  return {
    ktg, kvl, kip,
    use: +(ktg * kvl * kip / 1e4).toFixed(1),
    revenueMln: pick(c.goalRevenueMln, GOAL_DEFAULTS.goalRevenueMln),
    kmDay: pick(c.dailyKmTarget, GOAL_DEFAULTS.dailyKmTarget),
    fleet: pick(c.fleetTarget, GOAL_DEFAULTS.fleetTarget),
    fotPct: pick(c.fotNormPct, GOAL_DEFAULTS.fotNormPct),
    kpiOwnPct: pick(c.kpiOwnSharePct, GOAL_DEFAULTS.kpiOwnSharePct),
    signalTargetH: pick(c.signalTargetHours, GOAL_DEFAULTS.signalTargetHours),
    gateLongH: pick(c.gateLongHours, GOAL_DEFAULTS.gateLongHours)
  };
}
