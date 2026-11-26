import { expect, test } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loginCookie, testDeps } from '../helpers.js';

const hit = { key: 'kr:005930', market: 'kr' as const, name: '삼성전자', symbol: '005930' };

test('search needs login and returns hits', async () => {
  const deps = testDeps({ instruments: { search: async (q: string) => (q === '삼' ? [hit] : []), nameOf: () => null, koreanCoinName: () => null, findKrCode: () => null, warm: async () => {} } });
  const app = await buildApp(deps);
  expect((await app.inject({ method: 'GET', url: '/api/search?q=%EC%82%BC' })).statusCode).toBe(401);
  const cookie = await loginCookie(app);
  expect((await app.inject({ method: 'GET', url: '/api/search?q=%EC%82%BC', headers: { cookie } })).json()).toEqual({ hits: [hit] });
  expect((await app.inject({ method: 'GET', url: '/api/search?q=', headers: { cookie } })).json()).toEqual({ hits: [] });
});

test('quote returns the display name when the catalog knows it', async () => {
  const deps = testDeps({ instruments: { search: async () => [], nameOf: (k: string) => (k === 'coin:BTC-USDT' ? '비트코인' : null), koreanCoinName: () => null, findKrCode: () => null, warm: async () => {} } });
  const app = await buildApp(deps);
  const cookie = await loginCookie(app);
  expect((await app.inject({ method: 'GET', url: '/api/market/quote?key=coin:BTC-USDT', headers: { cookie } })).json().name).toBe('비트코인');
});

test('trending and market overview routes', async () => {
  const deps = testDeps({
    trending: { get: async (m: string, k: string) => (m === 'coin' && k === 'gainers' ? [{ key: 'coin:BTC-USDT', name: '비트코인', symbol: 'BTC', price: 1, changePct: 5, value: 1, currency: 'USDT' as const }] : []) },
    overview: { get: async () => [{ id: 'kospi' as const, label: '코스피', value: 2650, changePct: 0.4, note: null, open: null }] },
  });
  const app = await buildApp(deps);
  const cookie = await loginCookie(app);
  expect((await app.inject({ method: 'GET', url: '/api/trending/coin?kind=gainers', headers: { cookie } })).json().items).toHaveLength(1);
  expect((await app.inject({ method: 'GET', url: '/api/trending/kr', headers: { cookie } })).json()).toEqual({ items: [], needsKey: true });
  expect((await app.inject({ method: 'GET', url: '/api/trending/coin?kind=wrong', headers: { cookie } })).statusCode).toBe(400);
  expect((await app.inject({ method: 'GET', url: '/api/trending/zz', headers: { cookie } })).statusCode).toBe(400);
  expect((await app.inject({ method: 'GET', url: '/api/market-overview', headers: { cookie } })).json().items[0].label).toBe('코스피');
});

test('news and instrument info routes', async () => {
  const seen: { q: string; range?: { from: number; to: number } }[] = [];
  const deps = testDeps({
    instruments: { search: async () => [], nameOf: (k: string) => (k === 'kr:005930' ? '삼성전자' : null), koreanCoinName: () => null, findKrCode: () => null, warm: async () => {} },
    news: { search: async (q: string, range?: { from: number; to: number }) => { seen.push({ q, range }); return [{ title: '기사', url: 'https://example.com/a', source: '한경', publishedAt: 1 }]; } },
    instrumentInfo: { get: async () => ({ stock: null, coin: null }) },
  });
  const app = await buildApp(deps);
  const cookie = await loginCookie(app);
  expect((await app.inject({ method: 'GET', url: '/api/news?key=kr:005930', headers: { cookie } })).json().items).toHaveLength(1);
  await app.inject({ method: 'GET', url: '/api/news?key=kr:005930&from=100&to=200', headers: { cookie } });
  expect(seen).toEqual([{ q: '삼성전자', range: undefined }, { q: '삼성전자', range: { from: 100, to: 200 } }]);
  expect((await app.inject({ method: 'GET', url: '/api/news?key=bad', headers: { cookie } })).statusCode).toBe(400);
  expect((await app.inject({ method: 'GET', url: '/api/instrument/info?key=kr:005930', headers: { cookie } })).json()).toEqual({ stock: null, coin: null });
  expect((await app.inject({ method: 'GET', url: '/api/instrument/info?key=bad', headers: { cookie } })).statusCode).toBe(400);
});

test('trending says when stock rankings need the KIS key', async () => {
  const trending = { get: async () => [] };
  const noKey = await buildApp(testDeps({ trending, connected: { kis: false } }));
  const c1 = await loginCookie(noKey);
  expect((await noKey.inject({ method: 'GET', url: '/api/trending/kr', headers: { cookie: c1 } })).json()).toEqual({ items: [], needsKey: true });
  expect((await noKey.inject({ method: 'GET', url: '/api/trending/coin', headers: { cookie: c1 } })).json()).toEqual({ items: [], needsKey: false });
  const withKey = await buildApp(testDeps({ trending, connected: { kis: true } }));
  const c2 = await loginCookie(withKey);
  expect((await withKey.inject({ method: 'GET', url: '/api/trending/kr', headers: { cookie: c2 } })).json()).toEqual({ items: [], needsKey: false });
});

test('with Naver stock prices, stock rankings never ask for the KIS key', async () => {
  const app = await buildApp(testDeps({ trending: { get: async () => [] }, connected: { kis: false }, stocksAvailable: true }));
  const cookie = await loginCookie(app);
  expect((await app.inject({ method: 'GET', url: '/api/trending/kr', headers: { cookie } })).json()).toEqual({ items: [], needsKey: false });
});

test('logo route sends the image with caching, or 404', async () => {
  const deps = testDeps({ logos: { get: async (key: string) => (key === 'kr:005930' ? { type: 'image/png', body: Buffer.from([1, 2, 3]) } : null) } });
  const app = await buildApp(deps);
  const cookie = await loginCookie(app);
  const ok = await app.inject({ method: 'GET', url: '/api/logo?key=kr:005930', headers: { cookie } });
  expect(ok.statusCode).toBe(200);
  expect(ok.headers['content-type']).toBe('image/png');
  expect(String(ok.headers['cache-control'])).toContain('max-age');
  expect(ok.rawPayload.length).toBe(3);
  expect((await app.inject({ method: 'GET', url: '/api/logo?key=kr:000000', headers: { cookie } })).statusCode).toBe(404);
  expect((await app.inject({ method: 'GET', url: '/api/logo?key=kr:005930' })).statusCode).toBe(401);
});
