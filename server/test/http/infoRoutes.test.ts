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
    overview: { get: async () => [{ id: 'kospi' as const, label: '코스피', value: 2650, changePct: 0.4, note: null }] },
  });
  const app = await buildApp(deps);
  const cookie = await loginCookie(app);
  expect((await app.inject({ method: 'GET', url: '/api/trending/coin?kind=gainers', headers: { cookie } })).json().items).toHaveLength(1);
  expect((await app.inject({ method: 'GET', url: '/api/trending/kr', headers: { cookie } })).json()).toEqual({ items: [] });
  expect((await app.inject({ method: 'GET', url: '/api/trending/coin?kind=wrong', headers: { cookie } })).statusCode).toBe(400);
  expect((await app.inject({ method: 'GET', url: '/api/trending/zz', headers: { cookie } })).statusCode).toBe(400);
  expect((await app.inject({ method: 'GET', url: '/api/market-overview', headers: { cookie } })).json().items[0].label).toBe('코스피');
});
