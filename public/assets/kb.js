// 📚 База знаний: поиск по статьям и инструкциям (02.11.2026).
// Статей — сотни, не миллионы, поэтому поиск честный и простой: без
// внешних движков, работает и на фронте («❓ Справка» в чате), и в
// тестах. Словоформы русского ловятся лёгким стеммингом (обрезка
// окончания), «ё» равна «е».

// Слова-пустышки: встречаются в любом вопросе и в любом тексте — в
// поиске только шумят («как создать заявку» должен искать «заявку»).
const KB_STOP = new Set(['как', 'что', 'это', 'эта', 'этот', 'где', 'куда', 'откуда',
  'почему', 'зачем', 'когда', 'надо', 'нужно', 'можно', 'нельзя', 'если', 'при',
  'для', 'или', 'сделать', 'делать', 'мне', 'нас', 'все', 'всё']);

// Токены текста: нижний регистр, ё→е, только буквы/цифры, слова от
// 3 символов, без пустышек.
export function kbTokens(text) {
  return String(text || '').toLowerCase().replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9\s]/g, ' ')
    .split(/\s+/).filter(word => word.length >= 3 && !KB_STOP.has(word));
}

// Лёгкая основа слова: у длинных слов срезаем 2 символа окончания,
// у средних — 1 («заявку/заявки/заявке» → «заявк» ловятся подстрокой).
export function kbStem(word) {
  if (word.length >= 6) return word.slice(0, -2);
  if (word.length >= 4) return word.slice(0, -1);
  return word;
}

const normalize = text => ' ' + kbTokens(text).join(' ') + ' ';

// Поиск: балл статьи = совпадения основ запроса (вопрос весит втрое
// против ответа) + бонус за дословное вхождение всего запроса.
// Возвращает топ подходящих с баллом > 0.
export function kbSearch(articles, query, limit = 5) {
  const stems = [...new Set(kbTokens(query).map(kbStem))];
  if (!stems.length) return [];
  const phrase = normalize(query).trim();
  return articles.map(article => {
    const inQuestion = normalize(article.question);
    const inAnswer = normalize(`${article.answer} ${article.section}`);
    let score = 0;
    for (const stem of stems) {
      if (inQuestion.includes(stem)) score += 3;
      else if (inAnswer.includes(stem)) score += 1;
    }
    if (phrase.includes(' ') && inQuestion.includes(phrase)) score += 5;
    return { article, score };
  }).filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// Поиск по инструкциям (GUIDES): html раздела → текст, те же основы.
// Возвращает разделы, где нашлись все... нет — хотя бы половина основ.
export function kbSearchGuides(guides, query, limit = 3) {
  const stems = [...new Set(kbTokens(query).map(kbStem))];
  if (!stems.length) return [];
  return guides.map(guide => {
    const text = normalize(String(guide.html).replace(/<[^>]+>/g, ' '));
    let hits = 0;
    for (const stem of stems) if (text.includes(stem)) hits += 1;
    return { guide, score: hits };
  }).filter(item => item.score * 2 >= stems.length)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
