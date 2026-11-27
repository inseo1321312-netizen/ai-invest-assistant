import { expect, test } from 'vitest';
import { buildApp } from '../../src/app.js';
import { saveHolding } from '../../src/features/holdings.js';
import { loginCookie, testDeps } from '../helpers.js';

test('holdings list with live price and profit from the average price; delete removes one', async () => {
  const deps = testDeps();
  saveHolding(deps.db, 'coin:BTC-USDT', { quantity: 0.5, avgPrice: 50 }, deps.now());
  const app = await buildApp(deps);
  const cookie = await loginCookie(app);
  const res = (await app.inject({ method: 'GET', url: '/api/holdings', headers: { cookie } })).json();
  expect(res.items).toHaveLength(1);
  const h = res.items[0];
  expect(h).toMatchObject({ key: 'coin:BTC-USDT', quantity: 0.5, avgPrice: 50, instrument: { market: 'coin', symbol: 'BTC-USDT' } });
  expect(h.quote?.price).toBeGreaterThan(0);
  expect(h.plPct).toBeCloseTo((h.quote.price / 50 - 1) * 100, 6);
  const del = await app.inject({ method: 'DELETE', url: '/api/holdings?key=coin%3ABTC-USDT', headers: { cookie } });
  expect(del.statusCode).toBe(200);
  expect((await app.inject({ method: 'GET', url: '/api/holdings', headers: { cookie } })).json().items).toEqual([]);
});

test('my news comes from favorites and holdings', async () => {
  const t = Math.floor(testDeps().now() / 1000);
  const deps = testDeps({ news: { search: async () => [{ title: '비트코인 소식', url: 'https://n/1', source: 'A', publishedAt: t - 60 }] } });
  deps.market.addWatch('coin:BTC-USDT');
  const app = await buildApp(deps);
  const cookie = await loginCookie(app);
  const res = (await app.inject({ method: 'GET', url: '/api/news/mine', headers: { cookie } })).json();
  expect(res.items).toEqual([expect.objectContaining({ key: 'coin:BTC-USDT', title: '비트코인 소식', url: 'https://n/1' })]);
});
