// Местное время точек рейса (этап 1 часовых поясов, заявка Базуева 05.11):
// планер живёт в МСК, а погрузки в Сибири — по местным часам. Пояс
// определяется по тексту пункта: справочник-география «регион/город →
// смещение от МСК» (административные пояса РФ, не бизнес-константы).
// Точка без восточного маркера считается московской — подсказка не нужна.
const OFFSETS = [
  // +1 МСК (Самара UTC+4)
  ['самар', 1], ['тольятти', 1], ['сызран', 1], ['ульяновск', 1], ['димитровград', 1],
  ['саратов', 1], ['энгельс', 1], ['ижевск', 1], ['удмурт', 1], ['астрахан', 1],
  // +2 МСК (Екатеринбург UTC+5)
  ['оренбург', 2], ['орск', 2], ['уфа', 2], ['башкор', 2], ['стерлитамак', 2],
  ['перм', 2], ['екатеринбург', 2], ['свердлов', 2], ['нижний тагил', 2],
  ['челябин', 2], ['магнитогорск', 2], ['копейск', 2], ['курган', 2],
  ['тюмен', 2], ['тобольск', 2], ['голышманово', 2], ['сургут', 2], ['ханты', 2],
  // +3 МСК (Омск UTC+6)
  ['омск', 3],
  // +4 МСК (Новосибирск/Красноярск UTC+7)
  ['новосибир', 4], ['бердск', 4], ['криводановка', 4], ['томск', 4],
  ['кемеров', 4], ['кузбасс', 4], ['новокузнецк', 4], ['юрга', 4],
  ['алтай', 4], ['барнаул', 4], ['бийск', 4],
  ['красноярск', 4], ['ачинск', 4], ['канск', 4], ['хакас', 4], ['абакан', 4],
  // +5 МСК (Иркутск UTC+8)
  ['иркутск', 5], ['ангарск', 5], ['братск', 5],
  // +6 МСК (Чита UTC+9)
  ['чита', 6], ['улан-удэ', 6], ['бурят', 6]
];

// Смещение точки от МСК в часах (0 — московское время или пояс не распознан).
export function tzOffsetHours(pointText) {
  const text = String(pointText || '').toLowerCase();
  if (!text) return 0;
  for (const [needle, hours] of OFFSETS) if (text.includes(needle)) return hours;
  return 0;
}

// Подсказка местного времени: «· 21:00 местн. (+4)» — только когда пояс
// точки отличается от МСК и время валидно. Рендер — сдвигом момента:
// формат в МСК со сдвинутым временем и есть местные часы.
const fmt = new Intl.DateTimeFormat('ru-RU', {
  hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
export function localTimeHint(pointText, iso) {
  const offset = tzOffsetHours(pointText);
  const ms = Date.parse(iso || '');
  if (!offset || !Number.isFinite(ms)) return '';
  return ` · ${fmt.format(new Date(ms + offset * 3_600_000))} местн. (+${offset})`;
}

// ── Этап 3 поясов (заявка Базуева 09.11) ────────────────────────────────
// В заявке клиента время у восточной точки стоит по МЕСТНЫМ часам этой
// точки. Сотрудник вносит его в форму «как в заявке», планер при
// сохранении сам переводит в МСК; хранение и контроль — по-прежнему МСК.
// Правило действует на ввод с момента выпуска, старые записи не трогаем.

// Ввод (местное время точки, ISO) → хранимое МСК: минус смещение пояса.
export function mskFromLocal(iso, pointText) {
  const offset = tzOffsetHours(pointText);
  const ms = Date.parse(iso || '');
  if (!offset || !Number.isFinite(ms)) return iso;
  return new Date(ms - offset * 3_600_000).toISOString();
}

// Обратный ход для предзаполнения форм: хранимое МСК → местное время
// точки, чтобы поле показывало то же число, что в заявке клиента.
export function localIsoFromMsk(iso, pointText) {
  const offset = tzOffsetHours(pointText);
  const ms = Date.parse(iso || '');
  if (!offset || !Number.isFinite(ms)) return iso;
  return new Date(ms + offset * 3_600_000).toISOString();
}

// Живая подсказка под полем datetime-local: как планер понял ввод.
// getPointText — актуальный текст пункта (его поле может меняться рядом).
// Возвращает refresh — дёргать при смене пункта.
export function wireLocalTimeHint(input, getPointText) {
  if (!input) return () => {};
  const hint = document.createElement('small');
  hint.className = 'muted';
  hint.style.display = 'none';
  input.insertAdjacentElement('afterend', hint);
  const refresh = () => {
    const offset = tzOffsetHours(getPointText());
    // Значение поля без зоны трактуем как UTC — так же, как остальные
    // метки времени планера (см. pipeline.js).
    const ms = Date.parse(`${String(input.value || '').slice(0, 16)}:00.000Z`);
    if (!offset || !Number.isFinite(ms)) { hint.style.display = 'none'; return; }
    const msk = new Date(ms - offset * 3_600_000);
    const pad = n => String(n).padStart(2, '0');
    hint.style.display = 'block';
    hint.textContent = `⏱ принято как местное точки (+${offset}) — по МСК ` +
      `${pad(msk.getUTCDate())}.${pad(msk.getUTCMonth() + 1)} ${pad(msk.getUTCHours())}:${pad(msk.getUTCMinutes())}`;
  };
  input.addEventListener('input', refresh);
  refresh();
  return refresh;
}
