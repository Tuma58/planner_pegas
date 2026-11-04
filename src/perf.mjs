// ⚙ Скорость (Э0 проекта docs/performance-plan.md, 04.11): измеримость
// прежде оптимизации. Сервер считает по каждому эндпоинту количество,
// p50/p95/максимум времени ответа и отданные байты; клиентские маячки
// (длительность тика, долгие задачи) копятся рядом. Срез дня
// переживает рестарт в app_meta; жалоба «висит» превращается в цифру.

// Путь к семье эндпоинтов: id/uuid/числа → :id, глубина до трёх сегментов.
export function normalizeApiPath(pathname) {
  const parts = String(pathname || '').split('?')[0].split('/').filter(Boolean);
  const mapped = parts.map(part =>
    /^[0-9a-f-]{8,}$/i.test(part) || /^\d+$/.test(part) ? ':id' : part);
  return '/' + mapped.slice(0, 4).join('/');
}

const RESERVOIR = 256; // замеров на эндпоинт для перцентилей

export function createPerfRegistry() {
  const endpoints = new Map(); // path -> {count, errors, bytes, maxMs, samples[]}
  const clients = new Map();   // userName -> {at, tickMs, parseMs, renderMs, longTasks, view}

  const record = (path, ms, bytes, status) => {
    const key = normalizeApiPath(path);
    let row = endpoints.get(key);
    if (!row) { row = { count: 0, errors: 0, bytes: 0, maxMs: 0, samples: [] }; endpoints.set(key, row); }
    row.count += 1;
    if (status >= 500) row.errors += 1;
    row.bytes += bytes || 0;
    if (ms > row.maxMs) row.maxMs = Math.round(ms);
    // Резервуар: первые N подряд, дальше классическое случайное
    // замещение — честные перцентили без хранения всего потока.
    if (row.samples.length < RESERVOIR) row.samples.push(ms);
    else {
      const slot = Math.floor(Math.random() * row.count);
      if (slot < RESERVOIR) row.samples[slot] = ms;
    }
    return key;
  };

  const beacon = (userName, payload) => {
    clients.set(String(userName || 'аноним').slice(0, 60), {
      at: Date.now(),
      view: String(payload.view || '').slice(0, 30),
      tickMs: Math.round(Number(payload.tickMs) || 0),
      parseMs: Math.round(Number(payload.parseMs) || 0),
      renderMs: Math.round(Number(payload.renderMs) || 0),
      longTasks: Math.round(Number(payload.longTasks) || 0),
      bytes: Math.round(Number(payload.bytes) || 0)
    });
  };

  const percentile = (samples, q) => {
    if (!samples.length) return 0;
    const sorted = [...samples].sort((a, b) => a - b);
    return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]);
  };

  const snapshot = () => ({
    since: startedAt,
    endpoints: [...endpoints].map(([path, row]) => ({
      path, count: row.count, errors: row.errors,
      mb: Math.round(row.bytes / 1e5) / 10,
      p50: percentile(row.samples, 0.5), p95: percentile(row.samples, 0.95),
      max: row.maxMs
    })).sort((a, b) => b.p95 * b.count - a.p95 * a.count),
    clients: [...clients].map(([name, row]) => ({ name, ...row }))
      .sort((a, b) => b.tickMs - a.tickMs)
  });

  const startedAt = new Date().toISOString();
  return { record, beacon, snapshot };
}
