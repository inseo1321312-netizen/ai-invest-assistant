import { expect, test } from 'vitest';
import { createInstrumentInfo } from '../../src/market/instrumentInfo.js';
import { makeClock } from '../helpers.js';
import { fakeKis, fakeOkx } from './fakes.js';

const NOW = Date.UTC(2026, 10, 26, 0, 0);

function setup(over: { inUpbit?: boolean } = {}) {
  const clock = makeClock(NOW);
  const okx = fakeOkx({
    async getFundingRate() { return 0.0001; },
    async getOpenInterest() { return { oiUsd: 1_900_000_000 }; },
    async getLongShortRatio() { return 2.37; },
    async getLiquidations() { return [
      { side: 'long' as const, usd: 1000, ts: NOW - 10 * 60_000 },
      { side: 'short' as const, usd: 500, ts: NOW - 20 * 60_000 },
      { side: 'long' as const, usd: 250, ts: NOW - 30 * 60_000 },
      { side: 'long' as const, usd: 9999, ts: NOW - 2 * 3600_000 },
    ]; },
    async getQuote(instId) { return { instrument: { market: 'coin', symbol: instId, kind: 'spot', exchange: null, name: null }, price: 60673, changePct24h: 0, currency: 'USDT', time: 0 }; },
  });
  const upbit = {
    krwPrices: async () => new Map(over.inUpbit === false ? [] : [['BTC', 82625000]]),
    markets: async () => (over.inUpbit === false ? [] : [{ market: 'KRW-BTC', koreanName: '비트코인', englishName: 'Bitcoin', warning: false, cautions: ['GLOBAL_PRICE_DIFFERENCES'] }]),
  };
  const kis = fakeKis({ async getBasicInfo(inst) { return { marketCap: inst.market === 'kr' ? 4.3e14 : null, per: 12.5, pbr: null, eps: 5000, high52: 88000, low52: 50000, currency: inst.market === 'kr' ? 'KRW' : 'USD' }; } });
  return { info: createInstrumentInfo({ kis, okx, upbit, fx: async () => 1345, now: clock.now }), clock };
}

test('coin: funding, open interest, long/short ratio, last-hour liquidations and kimchi premium', async () => {
  const { info } = setup();
  const r = await info.get('coin:BTC-USDT');
  expect(r.stock).toBeNull();
  expect(r.coin).toMatchObject({ fundingRate: 0.0001, openInterestUsd: 1_900_000_000, longShortRatio: 2.37, liq1h: { longUsd: 1250, shortUsd: 500 }, upbitWarning: false, upbitCautions: ['GLOBAL_PRICE_DIFFERENCES'] });
  expect(r.coin!.kimchiPct).toBeCloseTo((82625000 / (60673 * 1345) - 1) * 100, 6);
});

test('coin not on Upbit has no premium or warnings', async () => {
  const { info } = setup({ inUpbit: false });
  const r = await info.get('coin:BTC-USDT');
  expect(r.coin).toMatchObject({ kimchiPct: null, upbitWarning: false, upbitCautions: [] });
});

test('stock: fundamentals from KIS', async () => {
  const { info } = setup();
  const r = await info.get('kr:005930');
  expect(r.coin).toBeNull();
  expect(r.stock).toEqual({ marketCap: 4.3e14, per: 12.5, pbr: null, eps: 5000, high52: 88000, low52: 50000, currency: 'KRW' });
});

test('stock without the KIS key has no fundamentals', async () => {
  const clock = makeClock(NOW);
  const info = createInstrumentInfo({ kis: null, okx: fakeOkx(), upbit: { krwPrices: async () => new Map(), markets: async () => [] }, fx: async () => 1345, now: clock.now });
  expect(await info.get('us:NAS:AAPL')).toEqual({ stock: null, coin: null });
});
