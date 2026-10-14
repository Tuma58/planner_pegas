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
