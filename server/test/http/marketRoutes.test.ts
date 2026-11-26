import { expect, test } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createMarketService } from '../../src/market/service.js';
import { parseInstrumentKey, type Holding } from '../../src/market/types.js';
import { loginCookie, testDeps } from '../helpers.js';
import { fakeKis, fakeOkx } from '../market/fakes.js';

const pos = (key: string, extra: Partial<Holding>): Holding => ({
  instrument: parseInstrumentKey(key), quantity: 1, avgPrice: 100, currency: 'USDT', source: 'okx',
  side: null, leverage: null, liqPrice: null, markPrice: null, unrealizedPnl: null, fundingRate: null, ...extra,
});

async function setup(okx = fakeOkx(), kis = fakeKis()) {
  const deps = testDeps();
  deps.market = createMarketService({ okx, kis, db: deps.db, now: deps.now, fx: async () => 1400 });
  deps.connected = { okx: true, kis: true };
  const app = await buildApp(deps);
  const cookie = await loginCookie(app);
  return { app, cookie, deps };
}

test('routes require login', async () => {
  const { app } = await setup();
  expect((await app.inject({ method: 'GET', url: '/api/market/coin/overview' })).statusCode).toBe(401);
});

test('overview: krwValue uses usdKrw for USDT, pnlPct inverted for short', async () => {
  const okx = fakeOkx({ async getHoldings() { return [pos('coin:BTC-USDT-SWAP', { side: 'short', quantity: 0.5, avgPrice: 110, leverage: 10 })]; } });
  const { app, cookie } = await setup(okx);
  const res = await app.inject({ method: 'GET', url: '/api/market/coin/overview', headers: { cookie } });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.usdKrw).toBe(1400);
  const h = body.holdings[0];
  expect(h.key).toBe('coin:BTC-USDT-SWAP');
  expect(h.quote.price).toBe(100);
  expect(h.krwValue).toBe(100 * 0.5 * 1400);
  expect(h.pnlPct).toBeCloseTo(((110 - 100) / 110) * 100, 6); // 숏: 가격이 내려가면 +
  expect(h.badge).toBeNull();
});

test('overview: KRW holdings use raw value', async () => {
  const kis = fakeKis({ async getHoldings() { return [pos('kr:005930', { currency: 'KRW', source: 'kis', quantity: 10, avgPrice: 65000 })]; } });
  const { app, cookie } = await setup(fakeOkx(), kis);
  const body = (await app.inject({ method: 'GET', url: '/api/market/kr/overview', headers: { cookie } })).json();
  expect(body.holdings[0].krwValue).toBe(700000);
  expect(body.holdings[0].pnlPct).toBeCloseTo(((70000 - 65000) / 65000) * 100, 6);
});

test('overview reports source error but still returns manual holdings', async () => {
  const okx = fakeOkx({ async getHoldings() { throw new Error('boom'); } });
  const { app, cookie, deps } = await setup(okx);
  deps.market.addManualHolding({ key: 'coin:ETH-USDT', quantity: 1, avgPrice: 90, side: null, leverage: null });
  const body = (await app.inject({ method: 'GET', url: '/api/market/coin/overview', headers: { cookie } })).json();
  expect(body.errors).toEqual(['OKX 데이터를 가져오지 못했습니다']);
  expect(body.holdings.map((h: { key: string }) => h.key)).toEqual(['coin:ETH-USDT']);
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

test('watchlist and manual holdings endpoints', async () => {
  const { app, cookie } = await setup();
  await app.inject({ method: 'POST', url: '/api/watchlist', headers: { cookie }, payload: { key: 'coin:SOL-USDT' } });
  let body = (await app.inject({ method: 'GET', url: '/api/market/coin/overview', headers: { cookie } })).json();
  expect(body.watchlist.map((w: { key: string }) => w.key)).toEqual(['coin:SOL-USDT']);
  await app.inject({ method: 'DELETE', url: '/api/watchlist?key=coin:SOL-USDT', headers: { cookie } });
  const add = await app.inject({ method: 'POST', url: '/api/manual-holdings', headers: { cookie }, payload: { key: 'kr:005930', quantity: 3, avgPrice: 60000, side: null, leverage: null } });
  expect(add.statusCode).toBe(200);
  body = (await app.inject({ method: 'GET', url: '/api/market/kr/overview', headers: { cookie } })).json();
  expect(body.holdings).toHaveLength(1);
  await app.inject({ method: 'DELETE', url: `/api/manual-holdings/${add.json().id}`, headers: { cookie } });
  body = (await app.inject({ method: 'GET', url: '/api/market/kr/overview', headers: { cookie } })).json();
  expect(body.holdings).toHaveLength(0);
  expect(body.connected).toBe(true);
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
