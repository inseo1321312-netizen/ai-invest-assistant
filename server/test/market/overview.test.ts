import { expect, test } from 'vitest';
import { createMarketOverview } from '../../src/market/overview.js';
import { makeClock } from '../helpers.js';
import { fakeKis } from './fakes.js';

const kis = fakeKis({
  async getIndex(code) { return code === '0001' ? { value: 2650, changePct: 0.4 } : { value: 850, changePct: -0.2 }; },
  async getUsIndex(sym) { return sym === 'SPX' ? { value: 6000, changePct: 0.1 } : { value: 19000, changePct: 0.3 }; },
});
const base = {
  kis,
  fx: async () => 1345 as number | null,
  sentiment: async () => ({ value: 11, label: '극도의 공포', updatedAt: 0 }),
  upbit: { krwPrices: async () => new Map([['BTC', 82625000]]) },
  okx: { getQuote: async () => ({ price: 60673 }) },
  metals: async (code: string) => ({ value: ({ GCcv1: 3671, SIcv1: 43.72, HGcv1: 5.5635 } as Record<string, number>)[code]!, changePct: 1 }),
};

test('all items, with the kimchi premium from Upbit, OKX and the exchange rate', async () => {
  const items = await createMarketOverview({ ...base, now: makeClock().now }).get();
  expect(items.map((i) => i.id)).toEqual(['kospi', 'kosdaq', 'spx', 'nasdaq', 'usdkrw', 'fng', 'kimchi', 'gold', 'silver', 'copper']);
  expect(items.map((i) => i.label)).toEqual(['코스피', '코스닥', 'S&P500', '나스닥', '원/달러', '공포·탐욕', '김치 프리미엄', '금', '은', '구리']);
  expect(items[0]).toMatchObject({ value: 2650, changePct: 0.4 });
  expect(items[5]).toMatchObject({ value: 11, note: '극도의 공포' });
  expect(items.slice(7).map((i) => i.value)).toEqual([3671, 43.72, 5.5635]);
  expect(items[6]!.value).toBeCloseTo((82625000 / (60673 * 1345) - 1) * 100, 6);
});

test('a missing exchange rate only blanks the rate and the premium', async () => {
  const items = await createMarketOverview({ ...base, fx: async () => null, now: makeClock().now }).get();
  expect(items.find((i) => i.id === 'usdkrw')!.value).toBeNull();
  expect(items.find((i) => i.id === 'kimchi')!.value).toBeNull();
  expect(items.find((i) => i.id === 'kospi')!.value).toBe(2650);
});

test('without the KIS key the four indices are blank', async () => {
  const items = await createMarketOverview({ ...base, kis: null, now: makeClock().now }).get();
  expect(items.slice(0, 4).every((i) => i.value === null)).toBe(true);
  expect(items[4]!.value).toBe(1345);
});

test('remembered for 60 seconds', async () => {
  let n = 0;
  const clock = makeClock();
  const o = createMarketOverview({ ...base, fx: async () => { n++; return 1345; }, now: clock.now });
  await o.get();
  await o.get();
  expect(n).toBe(1);
  clock.advance(61_000);
  await o.get();
  expect(n).toBe(2);
});

test('index tiles carry the open/closed state when the source knows it', async () => {
  const k = fakeKis({
    async getIndex(code) { return code === '0001' ? { value: 2650, changePct: 0.4, open: true } : { value: 850, changePct: -0.2 }; },
    async getUsIndex() { return { value: 6000, changePct: 0.1, open: false }; },
  });
  const items = await createMarketOverview({ ...base, kis: k, now: makeClock().now }).get();
  expect(items.slice(0, 4).map((i) => i.open)).toEqual([true, null, false, false]);
  expect(items[4]!.open).toBeNull();
});
