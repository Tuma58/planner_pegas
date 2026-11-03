// Коннектор «Дорожная сеть» (Dornet, back.dornet.ru) — первый API-источник
// журнала затрат (этап API плана docs/costs-plan.md, заказ 03.11).
// Клиентский API (роль ROLE_CLIENT): GET /client/..., токен в заголовке
// Authorization: Bearer, выборки по cid + from/to. Заказы каждого вида
// услуг несут госномер, сумму, дату и номер акта (УПД) — ложатся в
// журнал expenses записями source='api' с отпечатком dornet:<вид>:<id>:
// повторная синхронизация того же периода дублей не создаёт.
//
// Разбивка по видам услуг — решение руководителя 03.11: каждый вид едет
// в свою категорию справочника, итоги видны отдельными строками сводки.

export const DORNET_SERVICES = [
  { key: 'parking', path: 'points/parkings/orders', listKey: 'orders',
    label: 'Стоянки', category: 'parking', pointField: 'park_name' },
  { key: 'washing', path: 'points/washs/orders', listKey: 'orders',
    label: 'Мойки', category: 'wash', pointField: 'wash_name' },
  // Шиномонтаж — услуга (статья tirefit), не агрегат «Шины»: принцип
  // руководителя 03.11 — запчасть и работа учитываются раздельно.
  { key: 'tirefitting', path: 'points/tirefitting/orders', listKey: 'orders',
    label: 'Шиномонтаж', category: 'tirefit', pointField: 'pos_name' },
  { key: 'sto', path: 'points/sto/orders', listKey: 'orders',
    label: 'СТО', category: 'repair', pointField: 'sto_name' },
  { key: 'store', path: 'points/stores/orders', listKey: 'orders',
    label: 'Расходники', category: 'parts', pointField: 'store_name' },
  { key: 'tentrepair', path: 'points/tentrepair/orders', listKey: 'orders',
    label: 'Ремонт тентов', category: 'repair', pointField: 'tentrepair_name' },
  { key: 'tow', path: 'points/tows/orders', listKey: 'orders',
    label: 'Эвакуация', category: 'other', pointField: 'tow_name' },
  { key: 'shop', path: 'points/shops/orders', listKey: 'orders',
    label: 'Антилёд', category: 'other', pointField: 'shop_name' },
  { key: 'mail', path: 'points/mails/orders', listKey: 'orders',
    label: 'Доставка почты', category: 'other', pointField: 'mailpoint_name' },
  { key: 'fines', path: 'fines/list', listKey: 'fines',
    label: 'Штрафы', category: 'fines', pointField: null }
];

// Длинный период бьётся на куски ≤31 дня: выборка стоянок за месяц —
// самая тяжёлая (урок 03.11: «Стоянки: fetch failed» на бэкафилле
// октября — месяц целиком не доехал с одной попытки).
export function dornetChunks(from, to, maxDays = 31) {
  const chunks = [];
  let cursor = Date.parse(from);
  const endMs = Date.parse(to);
  if (!Number.isFinite(cursor) || !Number.isFinite(endMs) || cursor > endMs) return chunks;
  while (cursor <= endMs) {
    const chunkEnd = Math.min(cursor + (maxDays - 1) * 86_400_000, endMs);
    chunks.push([new Date(cursor).toISOString().slice(0, 10),
      new Date(chunkEnd).toISOString().slice(0, 10)]);
    cursor = chunkEnd + 86_400_000;
  }
  return chunks;
}

// День затраты из полей Dornet: заказы несут date_time («2026-10-01
// 01:34:49»), штрафы — date_time штрафа; почта — delivered («01.09.2021,
// 14:10:00»). Канон разбора тот же, что у импорта Excel.
function dornetDay(raw) {
  const text = String(raw || '').trim();
  let match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) return match[0];
  match = text.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
  return match ? `${match[3]}-${match[2]}-${match[1]}` : null;
}

// Заказы вида услуг → строки журнала затрат (чистая функция, тесты).
// Штраф считается затратой, только когда Dornet его оплатил
// (gis_status='payed'); сумма — к оплате с учётом скидки: именно она
// списывается с баланса. Остальные заказы — сумма как есть (с НДС).
export function dornetExpenseRows(service, items) {
  const rows = [];
  for (const item of items || []) {
    if (!item || !item.id) continue;
    if (service.key === 'fines') {
      if (item.gis_status !== 'payed') continue;
      const amount = Number(item.pay_bill_amount_with_discount || item.pay_bill_amount || 0);
      const day = dornetDay(item.pay_bill_date || item.date_time);
      if (!amount || !day) continue;
      rows.push({
        spent_on: day, category_id: service.category, amount,
        plate: String(item.reg_no || ''),
        supplier: 'Dornet · штрафы',
        doc_ref: String(item.gis_bill_id || `dornet-${item.id}`),
        note: String(item.offense_article_number || '').slice(0, 140),
        import_key: `dornet:fines:${item.id}`
      });
      continue;
    }
    const amount = Number(item.sum || 0);
    const day = dornetDay(item.date_time || item.delivered);
    if (!amount || !day) continue;
    rows.push({
      spent_on: day, category_id: service.category, amount,
      plate: String(item.vehicle || ''),
      supplier: `Dornet · ${String(item[service.pointField] || service.label).slice(0, 100)}`,
      doc_ref: String(item.document_id || `dornet-${item.id}`),
      note: '',
      import_key: `dornet:${service.key}:${item.id}`
    });
  }
  return rows;
}
