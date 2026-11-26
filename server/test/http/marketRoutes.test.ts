import { expect, test } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createMarketService } from '../../src/market/service.js';
import { loginCookie, testDeps } from '../helpers.js';
import { fakeKis, fakeOkx } from '../market/fakes.js';

async function setup(okx = fakeOkx(), kis = fakeKis()) {
  const deps = testDeps();
  deps.market = createMarketService({ okx, kis, db: deps.db, now: deps.now, fx: async () => 1400 });
  deps.connected = { kis: true };
  const app = await buildApp(deps);
  const cookie = await loginCookie(app);
  return { app, cookie, deps };
}

test('routes require login', async () => {
  const { app } = await setup();
  expect((await app.inject({ method: 'GET', url: '/api/market/coin/overview' })).statusCode).toBe(401);
});

test('overview lists favorites with quotes and no holdings', async () => {
  const { app, cookie } = await setup();
  await app.inject({ method: 'POST', url: '/api/watchlist', headers: { cookie }, payload: { key: 'coin:SOL-USDT' } });
  const body = (await app.inject({ method: 'GET', url: '/api/market/coin/overview', headers: { cookie } })).json();
  expect(Object.keys(body).sort()).toEqual(['errors', 'favorites', 'recent', 'usdKrw']);
  expect(body.favorites.map((w: { key: string }) => w.key)).toEqual(['coin:SOL-USDT']);
  expect(body.favorites[0].quote.price).toBe(100);
  expect(body.favorites[0].krwValue).toBe(100 * 1400);
});

test('manual holdings routes are gone', async () => {
  const { app, cookie } = await setup();
  const res = await app.inject({ method: 'POST', url: '/api/manual-holdings', headers: { cookie }, payload: { key: 'kr:005930', quantity: 3, avgPrice: 60000, side: null, leverage: null } });
  expect(res.statusCode).toBe(404);
});

test('candles: upstream error → 502 Korean message', async () => {
  const kis = fakeKis({ async getCandles() { throw new Error('down'); } });
  const { app, cookie } = await setup(fakeOkx(), kis);
  const res = await app.inject({ method: 'GET', url: '/api/market/candles?key=kr:005930&bar=1D&limit=10', headers: { cookie } });
  expect(res.statusCode).toBe(502);
  expect(res.json()).toEqual({ error: '한국투자증권 데이터를 가져오지 못했습니다' });
});

test('candles: bad key → 400', async () => {
  const { app, cookie } = await setup();
  const res = await app.inject({ method: 'GET', url: '/api/market/candles?key=zz:1&bar=1D', headers: { cookie } });
  expect(res.statusCode).toBe(400);
});

test('favorites can be added and removed', async () => {
  const { app, cookie } = await setup();
  await app.inject({ method: 'POST', url: '/api/watchlist', headers: { cookie }, payload: { key: 'coin:SOL-USDT' } });
  await app.inject({ method: 'DELETE', url: '/api/watchlist?key=coin:SOL-USDT', headers: { cookie } });
  const body = (await app.inject({ method: 'GET', url: '/api/market/coin/overview', headers: { cookie } })).json();
  expect(body.favorites).toEqual([]);
});

test('sparklines return last 30 daily closes per key, skipping failures', async () => {
  const okx = fakeOkx();
  const kis = fakeKis({ async getCandles() { throw new Error('down'); } });
  const { app, cookie } = await setup(okx, kis);
  const res = await app.inject({ method: 'GET', url: '/api/market/sparklines?keys=coin:BTC-USDT,kr:005930,bad', headers: { cookie } });
  const body = res.json();
  expect(body.sparklines['coin:BTC-USDT']).toHaveLength(30);
  expect(body.sparklines['kr:005930']).toBeUndefined();
  expect(okx.calls[0]).toMatchObject({ bar: '1D' });
});

test('sentiment route returns the index, or null when it is not set up', async () => {
  const deps = testDeps();
  const app = await buildApp({ ...deps, sentiment: async () => ({ value: 61, label: '탐욕', updatedAt: 1 }) });
  const cookie = await loginCookie(app);
  expect((await app.inject({ method: 'GET', url: '/api/market/sentiment', headers: { cookie } })).json()).toEqual({ sentiment: { value: 61, label: '탐욕', updatedAt: 1 } });
  const bare = await buildApp(testDeps());
  const c2 = await loginCookie(bare);
  expect((await bare.inject({ method: 'GET', url: '/api/market/sentiment', headers: { cookie: c2 } })).json()).toEqual({ sentiment: null });
});

test('recent views appear in overview, excluding favorites', async () => {
  const { app, cookie } = await setup();
  for (const key of ['coin:SOL-USDT', 'coin:ETH-USDT']) await app.inject({ method: 'POST', url: '/api/recent', headers: { cookie }, payload: { key } });
  await app.inject({ method: 'POST', url: '/api/watchlist', headers: { cookie }, payload: { key: 'coin:SOL-USDT' } });
  const body = (await app.inject({ method: 'GET', url: '/api/market/coin/overview', headers: { cookie } })).json();
  expect(body.recent.map((r: { key: string }) => r.key)).toEqual(['coin:ETH-USDT']);
  expect(body.recent[0].quote.price).toBe(100);
  expect((await app.inject({ method: 'POST', url: '/api/recent', headers: { cookie }, payload: { key: 'bad' } })).statusCode).toBe(400);
});
