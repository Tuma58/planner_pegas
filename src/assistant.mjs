// 🤖 Внутренний помощник, ступень 2: подсказки в момент работы
// (дорожная карта — docs/ASSISTANT.md, решение руководителя 02.11.2026).
// Принципы: подсказывает — не запрещает; не больше одной подсказки на
// действие и не чаще раза в день на человека по теме; каждая подсказка
// оценивается («полезно/нет») — бесполезное правило видно и глохнет.

// Реестр правил. Новое правило = запись здесь + чистая функция + вывод
// на экран; счётчики показов/оценок общие (assistant_hints).
export const HINT_RULES = {
  'customer-gates': 'Ворота клиента при вводе заявки'
};

const h1 = value => Number(value).toFixed(1).replace('.', ',');

// Правило «ворота клиента»: выученные медианы часов на воротах этого
// клиента (gate_facts) заметно выше цели руководителя — продажам стоит
// заложить простой в ставку ДО бронирования. Чистая логика — под тестом.
// Порог срабатывания — полторы цели (gateTargetHours — настройка):
// подсказка о заметной боли, а не о каждом часе сверх цели; минимум
// образцов 3 — как у выученных ворот клиента в лестнице нормативов.
export function gateHint(load, unload, targetHours) {
  const threshold = targetHours * 1.5;
  const pains = [];
  if (unload && unload.s >= 3 && unload.h >= threshold) {
    pains.push(`на выгрузке в среднем ${h1(unload.h)} ч (${unload.s} рейс. за 28 дн)`);
  }
  if (load && load.s >= 3 && load.h >= threshold) {
    pains.push(`на погрузке в среднем ${h1(load.h)} ч (${load.s} рейс. за 28 дн)`);
  }
  if (!pains.length) return null;
  return {
    rule: 'customer-gates',
    text: `Машина у этого клиента стоит ${pains.join(', ')} при цели ${targetHours} ч — ` +
      'закладывайте простой в ставку или бесплатный простой в договор.'
  };
}

// Честная медиана ворот выгрузки клиента за 28 дней — ТА ЖЕ методика,
// что недельный дайджест «🚪 Дорогие ворота» (прибыл → выгружен,
// образцы 0,2–72 ч, от 3 рейсов). Клампованные gate_facts (0,5–8 ч)
// для правила не годятся: урок калибровки 02.11 — реальные тяжёлые
// клиенты (12+ ч) там невидимы, и правило молчало по построению.
export function customerUnloadStats(db, customerName, days = 28) {
  // Точное имя по trim: имя в форму приходит из справочника клиентов,
  // который сам собран из рейсов (lower() SQLite кириллицу не понижает —
  // регистровые трюки тут немые, урок теста 02.11).
  const key = String(customerName || '').trim();
  if (!key) return null;
  const hours = db.prepare(`SELECT arrived_at, unloaded_at FROM trips
      WHERE trim(customer_name)=? AND status IN ('unloaded','done','paid')
        AND arrived_at IS NOT NULL AND unloaded_at >= datetime('now', ?)`)
    .all(key, `-${Math.max(1, days)} day`)
    .map(trip => (Date.parse(trip.unloaded_at) - Date.parse(trip.arrived_at)) / 3_600_000)
    .filter(value => value > 0.2 && value < 72)
    .sort((a, b) => a - b);
  if (hours.length < 3) return null;
  return { h: Math.round(hours[Math.floor(hours.length / 2)] * 10) / 10, s: hours.length };
}

export function gateHintForCustomer(db, customerName, targetHours) {
  const key = String(customerName || '').trim();
  if (!key) return null;
  // Клиенту с простоем в договоре не подсказываем: ставка уже защищена,
  // претензии за его ворота идут сами (как в «Дорогих воротах»).
  const contractual = db.prepare(`SELECT 1 FROM customer_profiles
    WHERE trim(customer_name)=? AND demurrage_rate > 0 LIMIT 1`).get(key);
  if (contractual) return null;
  return gateHint(null, customerUnloadStats(db, key), targetHours);
}

// Троттлинг: та же подсказка тому же человеку — не чаще раза в сутки.
export function hintShownRecently(db, rule, context, userId) {
  return Boolean(db.prepare(`SELECT 1 FROM assistant_hints
    WHERE rule=? AND context=? AND user_id=? AND action='shown'
      AND datetime(created_at) > datetime('now','-1 day') LIMIT 1`)
    .get(rule, String(context).slice(0, 120), userId));
}

export function recordHint(db, rule, context, userId, action) {
  db.prepare(`INSERT INTO assistant_hints(rule,context,user_id,action)
    VALUES(?,?,?,?)`).run(rule, String(context).slice(0, 120), userId, action);
}

// Дрейф для «🧠 Живых нормативов»: показы и оценки за период по правилам.
export function hintStats(db, days = 14) {
  const rows = db.prepare(`SELECT rule, action, COUNT(*) c FROM assistant_hints
    WHERE datetime(created_at) > datetime('now', ?)
    GROUP BY rule, action`).all(`-${Math.max(1, days)} days`);
  const byRule = {};
  for (const row of rows) {
    const entry = byRule[row.rule] ||= { shown: 0, helpful: 0, useless: 0 };
    entry[row.action] = row.c;
  }
  return byRule;
}
