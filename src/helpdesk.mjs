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
