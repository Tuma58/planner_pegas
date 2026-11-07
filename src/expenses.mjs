// Учёт затрат (блок «Затраты», Э1+Э2 плана docs/costs-plan.md).
// Журнал фактических расходов: ручной ввод и импорт выгрузок Excel из
// личных кабинетов поставщиков. Деньги хранятся «как в документе» с
// флагом НДС; к без-НДС канону приводятся ставкой из Настроек
// калькуляции (никаких своих констант). Категории — живой справочник
// expense_categories (правит руководитель/админ), а не зашитый список:
// посев ниже — только стартовое наполнение меткой в app_meta.

import { effectivePermissions } from './permissions.mjs';

// Доступ к учёту затрат ПЕРСОНАЛЬНЫЙ (решение руководителя 03.11:
// «не общим, а пока только у меня»): право expenses:write осталось
// только у администратора, остальных впускает список логинов в
// Настройки → Пользователи («Доступ к затратам») — по образцу
// staffAccess. Роль manager сама по себе доступа НЕ даёт.
export function expensesAccess(user, settings) {
  if (!user) return false;
  if (effectivePermissions(user).includes('expenses:write')) return true;
  // Разделители — только запятая/точка с запятой: логины в системе
  // бывают с пробелом («Дарья Н»), по пробелу резать нельзя.
  const allowed = String(settings?.expenses?.access || '')
    .split(/[,;]+/).map(item => item.trim().toLowerCase()).filter(Boolean);
  return allowed.includes(String(user.username || '').toLowerCase());
}

// Посев категорий: kind — характер затраты для будущего живого
// норматива себестоимости (Э5): variable ложится на километры,
// fixed — на машино-дни. nature — природа статьи (принцип руководителя
// 03.11: агрегат и работа учитываются раздельно): goods — материал/
// агрегат (шины, запчасти, топливо), service — услуга/работа
// (шиномонтаж, ремонт, мойка). Руководитель волен менять и дополнять.
export const EXPENSE_CATEGORY_SEED = [
  ['fuel', 'Топливо', 'variable', 'goods'],
  ['parts', 'Запчасти', 'variable', 'goods'],
  ['tires', 'Шины', 'variable', 'goods'],
  ['repair', 'Ремонт (работы)', 'variable', 'service'],
  ['tirefit', 'Шиномонтаж', 'variable', 'service'],
  ['tolls', 'Платные дороги и Платон', 'variable', 'service'],
  ['wash', 'Мойка', 'variable', 'service'],
  ['parking', 'Стоянки', 'variable', 'service'],
  ['fines', 'Штрафы', 'variable', 'service'],
  ['salary', 'Зарплата водителей', 'fixed', 'service'],
  ['lease', 'Лизинг / амортизация', 'fixed', 'service'],
  ['insurance', 'Страхование', 'fixed', 'service'],
  ['tax', 'Налоги', 'fixed', 'service'],
  ['overhead', 'Накладные', 'fixed', 'service'],
  ['other', 'Прочее', 'fixed', 'service']
];

// День из ячейки выгрузки: «дд.мм.гггг» (возможно с временем),
// ISO «гггг-мм-дд», или порядковый номер даты Excel (дней с 30.12.1899 —
// так Excel хранит даты числом). Иначе null — строка не затрата.
export function parseExpenseDay(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    if (value < 20000 || value > 80000) return null; // не похоже на дату Excel
    const ms = Math.round((value - 25569) * 86_400_000); // 25569 = 01.01.1970
    return new Date(ms).toISOString().slice(0, 10);
  }
  const text = String(value).trim();
  let match = text.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
  if (match) return `${match[3]}-${match[2]}-${match[1]}`;
  match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? match[0] : null;
}

// Сумма из ячейки: число как есть; строка — с пробелами-разрядами,
// запятой-десятичной и знаком валюты. Ноль и мусор → null.
export function parseExpenseAmount(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value !== 0 ? value : null;
  let text = String(value ?? '').replace(/[\s ₽]/g, '').replace(/руб\.?/gi, '');
  // И точка, и запятая — точки разделяют разряды («1.234,56»), иначе
  // запятая — десятичная.
  if (text.includes('.') && text.includes(',')) text = text.replaceAll('.', '');
  text = text.replace(',', '.');
  const amount = Number(text);
  return Number.isFinite(amount) && amount !== 0 ? amount : null;
}

// Госномер из выгрузки нормализует normalizePlate сервера (гомоглифы
// латиницы → кириллица, без пробелов) — своей копии здесь нет нарочно.

// Отпечаток строки для дедупа импорта: повторная загрузка того же файла
// (или пересечение периодов выгрузок) не плодит дублей — уникальный
// индекс по import_key молча пропускает совпадение.
export function expenseFingerprint(row) {
  return [row.spent_on, row.category_id, Math.round(Number(row.amount) * 100),
    row.vehicle_id || '', String(row.doc_ref || '').trim().toLowerCase(),
    String(row.supplier || '').trim().toLowerCase()].join('|');
}

// Проверка записи журнала (ручной ввод и каждая строка импорта).
// categories — Map id → {id, name, kind, active}.
export function validateExpense(body, categories) {
  const spentOn = parseExpenseDay(body.spent_on ?? body.day);
  if (!spentOn) return { error: 'Не разобран день затраты (нужно дд.мм.гггг или гггг-мм-дд)' };
  const category = categories.get(String(body.category_id || ''));
  if (!category) return { error: 'Неизвестная категория затраты' };
  if (!category.active) return { error: `Категория «${category.name}» отключена` };
  const amount = parseExpenseAmount(body.amount);
  if (!amount) return { error: 'Не разобрана сумма (ноль — не затрата)' };
  return { value: {
    spent_on: spentOn,
    category_id: category.id,
    amount: Math.round(amount * 100) / 100,
    vat: body.vat === undefined ? 1 : (body.vat ? 1 : 0),
    supplier: String(body.supplier || '').trim().slice(0, 120),
    doc_ref: String(body.doc_ref || '').trim().slice(0, 120),
    note: String(body.note || '').trim().slice(0, 300)
  } };
}

// Бренд поставщика: часть до « · » — записи Dornet («Dornet · точка»)
// сворачиваются в единую строку поставщика, как в его акте за период.
export const supplierBrand = value =>
  String(value || '').split(' · ')[0].trim() || '— без поставщика';

// Сводка периода: итоги по категориям, группам (переменные/постоянные —
// структура учёта, решение руководителя 03.11), машинам и поставщикам
// (поставщик с единым счётом, как Dornet, виден одной суммой — сверка
// с его актом). К без-НДС приводится ставкой калькуляции (vat=0 —
// сумма уже без НДС, как в документе). categories — Map справочника,
// по нему статья узнаёт свою группу.
export function expensesSummary(items, vatRate, categories = new Map()) {
  const rate = Number(vatRate) > 0 ? Number(vatRate) : 0;
  const netOf = item => item.vat ? item.amount / (1 + rate) : item.amount;
  const roll = (map, key, item) => {
    const bucket = map.get(key) || { sum: 0, net: 0, count: 0 };
    bucket.sum += item.amount;
    bucket.net += netOf(item);
    bucket.count += 1;
    map.set(key, bucket);
  };
  const byCategory = new Map();
  const byVehicle = new Map();
  const byKind = new Map();
  const bySupplier = new Map();
  let total = 0;
  let totalNet = 0;
  for (const item of items) {
    total += item.amount;
    totalNet += netOf(item);
    roll(byCategory, item.category_id, item);
    roll(byKind, categories.get(item.category_id)?.kind || 'variable', item);
    roll(bySupplier, supplierBrand(item.supplier), item);
    if (item.vehicle_id) roll(byVehicle, item.vehicle_id, item);
  }
  const unpack = map => [...map].map(([key, bucket]) => ({ key,
    sum: Math.round(bucket.sum), net: Math.round(bucket.net), count: bucket.count }))
    .sort((a, b) => b.sum - a.sum);
  return { total: Math.round(total), totalNet: Math.round(totalNet),
    count: items.length, byCategory: unpack(byCategory), byVehicle: unpack(byVehicle),
    byKind: unpack(byKind), bySupplier: unpack(bySupplier).slice(0, 12) };
}

// Литры топлива из текста операции РН-Карт («ДТ-Лет · 800 л по 86.7 ₽ …»):
// сторно идёт отрицательной суммой — литры получают тот же знак, чтобы
// сумма за период была честной (путевые листы, Э1 07.11).
export function fuelLitersOf(note, amount = 1) {
  // \b не работает с кириллицей — границу слова после «л» проверяем сами.
  const match = /(\d+(?:[.,]\d+)?)\s*л(?![а-яёa-z])/iu.exec(String(note || ''));
  if (!match) return 0;
  const liters = Number(match[1].replace(',', '.'));
  if (!Number.isFinite(liters)) return 0;
  return Number(amount) < 0 ? -liters : liters;
}
