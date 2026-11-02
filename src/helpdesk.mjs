// 🛟 HELP DESK — заявки сотрудников на доработку планера (решение
// руководителя 02.11.2026). Любой сотрудник заполняет форму в чате;
// заявка видна всем (прозрачность + защита от повторов), решение о
// выполнении принимает только руководитель — статусами на карточке.
// Сами доработки идут обычным циклом разработки, этот контур лишь
// собирает и провожает заявки: очередь → решение → ответ автору.

export const HELPDESK_STATUSES = {
  new: 'новая',
  review: 'на рассмотрении',
  work: 'в работе',
  done: 'готово',
  rejected: 'отклонена'
};

// Частота — фиксированный список: по ней видно, что мешает людям
// ежедневно (чинить первым), а что всплыло один раз.
export const HELPDESK_FREQUENCIES = [
  'мешает каждый день', 'несколько раз в неделю', 'иногда', 'случилось один раз'
];

// Проверка формы заявки: суть обязательна и осмысленной длины,
// остальные поля подрезаются до разумных лимитов.
export function validateTicket(body = {}) {
  const problem = String(body.problem || '').trim().slice(0, 1000);
  if (problem.length < 10) {
    return { ok: false, error: 'Опишите, что не так, хотя бы одним предложением (от 10 символов)' };
  }
  return {
    ok: true,
    ticket: {
      place: String(body.place || '').trim().slice(0, 120),
      problem,
      expected: String(body.expected || '').trim().slice(0, 1000),
      frequency: HELPDESK_FREQUENCIES.includes(body.frequency) ? body.frequency : ''
    }
  };
}

// ── Ежедневный плакат-инструкция на табло (решение руководителя 02.11) ──
// Пока сотрудники привыкают к HELP DESK, объявление-инструкция висит на
// табло каждый день с 9:00 до 11:00 МСК. Окно и срок приучения — ниже;
// дата окончания лежит в app_meta ('helpdesk_promo_until') и
// продлевается/снимается без правки кода.
const MSK = 3 * 3_600_000;
export const HELPDESK_PROMO_DEFAULT_UNTIL = '2026-11-16';

// Пора ли вешать плакат: окно 9:00–10:59 МСК, день не позже даты
// окончания и сегодня ещё не публиковали. Возвращает день и момент
// снятия (11:00 МСК в UTC) — или null.
export function helpdeskPromoDue(nowMs, untilDay, publishedDay) {
  const msk = new Date(nowMs + MSK);
  if (msk.getUTCHours() < 9 || msk.getUTCHours() >= 11) return null;
  const day = msk.toISOString().slice(0, 10);
  if (day > String(untilDay || '') || day === publishedDay) return null;
  const endsAt = new Date(Date.UTC(msk.getUTCFullYear(), msk.getUTCMonth(),
    msk.getUTCDate(), 11) - MSK).toISOString();
  return { day, endsAt };
}

// Плакат 1920×1080 — тот же газетный почерк, что у вестника.
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function wrapPoster(text, maxChars) {
  const out = [];
  let line = '';
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    const next = line ? line + ' ' + word : word;
    if (next.length > maxChars && line) { out.push(line); line = word; }
    else line = next;
  }
  if (line) out.push(line);
  return out;
}

export function renderHelpdeskPosterSvg() {
  const W = 1920, H = 1080, M = 70;
  const INK = '#211d15', PAPER = '#f4efe3', ACCENT = '#1f6f54', RULE = '#8a8372';
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" fill="${PAPER}"/>`;
  const t = (x, y, size, text, { w = 400, anchor = 'start', fill = INK, italic = false } = {}) => {
    svg += `<text x="${x}" y="${y}" font-family="Georgia, serif" font-size="${size}" font-weight="${w}" text-anchor="${anchor}" fill="${fill}"${italic ? ' font-style="italic"' : ''}>${esc(text)}</text>`;
  };
  const line = (x1, y1, x2, y2, sw = 2, color = INK) => {
    svg += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${sw}"/>`;
  };
  line(M, 64, W - M, 64, 5); line(M, 70, W - M, 70, 1.5);
  t(W / 2, 134, 56, 'HELP DESK — ЗАЯВКА НА ДОРАБОТКУ ПЛАНЕРА', { w: 700, anchor: 'middle' });
  t(W / 2, 180, 27, 'мешает в работе · не хватает кнопки · хочется удобнее — теперь это заявка, а не разговор в коридоре',
    { anchor: 'middle', italic: true });
  line(M, 200, W - M, 200, 1.5); line(M, 206, W - M, 206, 5);

  // Левая широкая колонна — четыре шага с номерами.
  const steps = [
    ['Откройте чат', 'Кнопка 💬 в шапке планера. В списке переписок закреплена комната «🛟 HELP DESK» — она видна каждому сотруднику.'],
    ['Заполните заявку', 'Кнопка «✍ Новая заявка»: где (экран или вкладка) · что не так · как должно быть · как часто мешает. Скриншот или запись экрана — по желанию, это сильно помогает.'],
    ['Заявку видят все', 'Посмотрите чужие заявки — возможно, ваша боль уже заявлена и движется. Решение о выполнении по каждой принимает руководитель.'],
    ['Ответ придёт лично', 'В ленту «📬 Планер — лично»: принята · в работе · готово · отклонена (всегда с причиной). Если «готово» — обновите страницу и пользуйтесь.']
  ];
  const colR = M + 1180;
  let y = 282;
  steps.forEach(([head, body], index) => {
    svg += `<circle cx="${M + 34}" cy="${y - 12}" r="32" fill="${ACCENT}"/>`;
    t(M + 34, y + 2, 40, String(index + 1), { w: 700, anchor: 'middle', fill: PAPER });
    t(M + 92, y, 36, head, { w: 700 });
    let yy = y + 44;
    for (const ln of wrapPoster(body, 74)) { t(M + 92, yy, 27, ln); yy += 37; }
    y = Math.max(yy, y + 92) + 36;
  });

  // Правая узкая колонна — порядок и первые факты.
  line(colR - 36, 240, colR - 36, 930, 1.2, RULE);
  y = 288;
  t(colR, y, 34, 'Порядок', { w: 700, fill: ACCENT }); y += 50;
  const facts = [
    'Разбор заявок — каждое утро в 7:00: по каждой готовится заключение и решение.',
    'Отказ не бывает молчаливым — всегда с причиной, лично вам.',
    'Заявка — не жалоба на человека, а запрос на улучшение системы.',
    'Первая заявка уже выполнена в день подачи: пробег водителя теперь виден на карточках сцепок логиста.'
  ];
  for (const fact of facts) {
    const lines = wrapPoster(fact, 40);
    lines.forEach((ln, i) => { t(colR + (i ? 24 : 0), y, 26, i ? ln : '• ' + ln); y += 36; });
    y += 14;
  }

  svg += `<rect x="${M}" y="962" width="${W - 2 * M}" height="86" fill="${ACCENT}" rx="6"/>`;
  t(M + 36, 1014, 31, 'ПИШИТЕ — ПО ВАШИМ ЗАЯВКАМ ПЛАНЕР СТАНОВИТСЯ УДОБНЕЕ', { w: 700, fill: PAPER });
  t(W - M - 36, 1014, 24, 'чат 💬 → «🛟 HELP DESK»', { anchor: 'end', fill: '#dcd5be', w: 700 });
  svg += '</svg>';
  return svg;
}

// Личное авто-сообщение автору при смене статуса его заявки.
export function helpdeskStatusMessage(ticket, status, note = '') {
  const gist = ticket.problem.length > 80 ? `${ticket.problem.slice(0, 80)}…` : ticket.problem;
  const head = `🛟 Ваша заявка «${gist}»`;
  const tail = note ? (status === 'rejected' ? ` Причина: ${note}` : ` Комментарий: ${note}`) : '';
  switch (status) {
    case 'review': return `${head} — принята на рассмотрение.${tail}`;
    case 'work': return `${head} — взята в работу, сообщим о готовности.${tail}`;
    case 'done': return `${head} — выполнена ✅. Обновите страницу планера, чтобы увидеть изменение.${tail}`;
    case 'rejected': return `${head} — отклонена.${tail}`;
    default: return `${head} — возвращена в очередь (статус «${HELPDESK_STATUSES[status] || status}»).${tail}`;
  }
}
