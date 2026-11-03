// Коннектор «РН-Карт» (Роснефть, lkapi.rn-card.ru, WebAPI EMV v2) —
// топливный процессинг, второй API-источник журнала затрат (03.11,
// docs/costs-plan.md). Регламент: GET-методы, логин ЛК в query (u=),
// пароль — заголовком RnCard-Identity-Account-Pass (Base64), период
// операций не длиннее двух месяцев, транзакции доступны с задержкой
// до 2 часов; сам регламент велит качать операции в своё хранилище.
//
// Операция → запись журнала: Type 11 (обслуживание/покупка) — затрата,
// Type 24 (возврат на счёт) — сторно отрицательной суммой; типы 1/4 —
// движения баланса договора, не расходы по статьям. Дедуп — rncard:<id>.

import { parseExpenseDay } from './expenses.mjs';

// Код/категория услуги РН-Карт → статья журнала. Всё топливо (GCat
// FUEL: АИ-95, ДТ, СУГ, метан…) — «Топливо»; услуги — по кодам
// (мойка, шиномонтаж, оплата дорог); товары (масло, AdBlue) —
// «Запчасти» (материалы). Неизвестное — «Прочее», честно видно в
// сводке и правится категорией записи.
export function rncardCategoryOf(gcat, gcode) {
  if (gcat === 'FUEL') return 'fuel';
  const byCode = {
    gmoika: 'wash', gshm: 'tirefit', gDorog: 'tolls',
    gMasla: 'parts', gAdBlue: 'parts'
  };
  if (byCode[gcode]) return byCode[gcode];
  return gcat === 'GOODS' ? 'parts' : 'other';
}

// Операции РН-Карт → строки журнала (чистая функция, тесты на примерах
// из регламента). cardInfo — Map «номер карты → {plate, holder}» из
// списка карт договора (ТС карты заполняется в ЛК; примечание карты
// часто несёт госномер — фолбэк решает сервер при привязке).
export function rncardExpenseRows(operations, cardInfo = new Map()) {
  const rows = [];
  for (const oper of operations || []) {
    const type = Number(oper?.Type);
    if (type !== 11 && type !== 24) continue; // движения баланса — не затраты
    const sum = Number(oper.Sum);
    const day = parseExpenseDay(oper.Date);
    if (!Number.isFinite(sum) || !sum || !day || !oper.Code) continue;
    const card = String(oper.Card || '');
    const info = cardInfo.get(card) || {};
    const liters = Number(oper.Value) || 0;
    const noteParts = [
      String(oper.GName || '').trim(),
      liters ? `${liters} л${Number(oper.Price) ? ` по ${oper.Price} ₽` : ''}` : '',
      String(oper.Holder || info.holder || '').trim(),
      card ? `карта …${card.slice(-6)}` : ''
    ].filter(Boolean);
    rows.push({
      spent_on: day,
      category_id: rncardCategoryOf(String(oper.GCat || ''), String(oper.GCode || '')),
      amount: type === 24 ? -Math.abs(sum) : Math.abs(sum),
      plate: String(info.plate || ''),
      supplier: `РН-Карт · ${String(oper.Address || 'АЗС').trim().slice(0, 90)}`,
      doc_ref: String(oper.Rrn || oper.Code),
      note: noteParts.join(' · ').slice(0, 300),
      import_key: `rncard:${oper.Code}`
    });
  }
  return rows;
}
