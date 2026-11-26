import { vi } from 'vitest';

type Handler = (url: URL, init?: RequestInit) => unknown | Response;

/** fetch를 경로별 가짜 응답으로 바꾼다. 'GET /api/me' 처럼 메서드를 붙일 수도 있다. */
export function mockServer(routes: Record<string, Handler>) {
  const calls: { method: string; url: URL; body: unknown }[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost');
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null });
    const h = routes[`${method} ${url.pathname}`] ?? routes[url.pathname];
    if (!h) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
    const out = await h(url, init);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fn);
  return { calls };
}

export function sseResponse(events: object[]) {
  const body = events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

export const quote = (price: number, change: number, currency = 'USDT') => ({ price, changePct24h: change, currency, time: 0 });

export const overview = (over: Record<string, unknown> = {}) => ({ holdings: [], watchlist: [], usdKrw: 1400, connected: true, errors: [], ...over });
