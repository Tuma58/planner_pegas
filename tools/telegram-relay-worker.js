// Релей Telegram Bot API через Cloudflare Worker.
//
// Зачем: с ~08.09.2026 api.telegram.org недоступен из сетей РФ (TCP 443
// не отвечает и у хостера, и в офисе) — уведомления планера в Telegram
// перестали уходить. Сеть Cloudflare при этом доступна, поэтому запросы
// Bot API пропускаются через собственный воркер: путь и токен не
// меняются, воркер лишь переносит запрос до api.telegram.org.
//
// Развёртывание (5 минут, бесплатный тариф — 100 тыс. запросов/день):
//   1. dash.cloudflare.com → Workers & Pages → Create Worker;
//   2. вставить этот файл целиком, Deploy;
//   3. скопировать адрес вида https://<имя>.<аккаунт>.workers.dev;
//   4. на сервере планера выполнить:
//      INSERT INTO app_meta(key,value) VALUES('telegram_api_host','<имя>.<аккаунт>.workers.dev')
//        ON CONFLICT(key) DO UPDATE SET value=excluded.value;
//      (без https:// и без слэша) — планер подхватит на лету, деплой не нужен.
//
// Безопасность: воркер пропускает только пути /bot<токен>/… — как и сам
// api.telegram.org, секретом является токен бота; ничего не логирует.

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/bot')) {
      return new Response('только Bot API', { status: 403 });
    }
    return fetch(`https://api.telegram.org${url.pathname}${url.search}`, {
      method: request.method,
      headers: { 'Content-Type': request.headers.get('Content-Type') || 'application/json' },
      body: ['POST', 'PUT'].includes(request.method) ? await request.arrayBuffer() : undefined,
    });
  },
};
