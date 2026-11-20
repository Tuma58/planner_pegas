// Пульс табло: сборка плашек «против своей нормы» (живой норматив —
// медиана собственного ряда без сегодняшнего дня).
import test from 'node:test';
import assert from 'node:assert/strict';
import { pulseQuotes } from '../src/tablo.mjs';

const series = values => values.map((value, idx) => ({ day: `2026-11-${String(idx + 1).padStart(2, '0')}`, value }));

test('норма — медиана прошлых дней, сегодня в неё не входит', () => {
  const [quote] = pulseQuotes([{ key: 'online', label: 'На линии', better: 'up',
    series: series([100, 102, 104, 106, 120]) }]);
  assert.equal(quote.norm, 104); // медиана 100,102,104,106 → нижняя средняя
  assert.equal(quote.value, 120);
  assert.equal(quote.delta, 16);
  assert.equal(quote.tone, 'good');
});

test('у счётчиков «меньше — лучше» рост красит плашку в плохое', () => {
  const [quote] = pulseQuotes([{ key: 'nocrew', label: 'Без экипажа', better: 'down',
    series: series([2, 2, 3, 2, 7]) }]);
  assert.equal(quote.tone, 'bad');
  const [drop] = pulseQuotes([{ key: 'nocrew', label: 'Без экипажа', better: 'down',
    series: series([5, 4, 5, 4, 1]) }]);
  assert.equal(drop.tone, 'good');
});

test('пустые дни не ломают медиану, без истории — нейтральный тон', () => {
  const [quote] = pulseQuotes([{ key: 'rate', label: 'Ставка', better: 'up',
    series: series([null, null, null, 97]) }]);
  assert.equal(quote.norm, null);
  assert.equal(quote.delta, null);
  assert.equal(quote.tone, 'flat');
});

test('совпадение с нормой — ровный тон, спарклайн отдаёт весь ряд', () => {
  const [quote] = pulseQuotes([{ key: 'keip', label: 'КЭИП', better: 'up',
    series: series([80, 80, 80]) }]);
  assert.equal(quote.tone, 'flat');
  assert.deepEqual(quote.spark, [80, 80, 80]);
});
