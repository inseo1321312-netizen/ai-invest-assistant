import { expect, test } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loginCookie, testDeps } from '../helpers.js';

const hit = { key: 'kr:005930', market: 'kr' as const, name: '삼성전자', symbol: '005930' };

test('search needs login and returns hits', async () => {
  const deps = testDeps({ instruments: { search: async (q: string) => (q === '삼' ? [hit] : []), nameOf: () => null, koreanCoinName: () => null, warm: async () => {} } });
  const app = await buildApp(deps);
  expect((await app.inject({ method: 'GET', url: '/api/search?q=%EC%82%BC' })).statusCode).toBe(401);
  const cookie = await loginCookie(app);
  expect((await app.inject({ method: 'GET', url: '/api/search?q=%EC%82%BC', headers: { cookie } })).json()).toEqual({ hits: [hit] });
  expect((await app.inject({ method: 'GET', url: '/api/search?q=', headers: { cookie } })).json()).toEqual({ hits: [] });
});

test('quote returns the display name when the catalog knows it', async () => {
  const deps = testDeps({ instruments: { search: async () => [], nameOf: (k: string) => (k === 'coin:BTC-USDT' ? '비트코인' : null), koreanCoinName: () => null, warm: async () => {} } });
  const app = await buildApp(deps);
  const cookie = await loginCookie(app);
  expect((await app.inject({ method: 'GET', url: '/api/market/quote?key=coin:BTC-USDT', headers: { cookie } })).json().name).toBe('비트코인');
});
