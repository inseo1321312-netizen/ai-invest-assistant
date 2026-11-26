import { describe, expect, test } from 'vitest';
import { createTrending, rankCoins } from '../../src/market/trending.js';
import { makeClock } from '../helpers.js';
import { fakeKis } from './fakes.js';

const tickers = [
  { instId: 'AAA-USDT', last: 1.8, open24h: 1, volCcy24h: 500_000 },
  { instId: 'BBB-USDT', last: 1.2, open24h: 1, volCcy24h: 2_000_000 },
  { instId: 'CCC-USDT', last: 1.1, open24h: 1, volCcy24h: 50_000_000 },
  { instId: 'DDD-USDC', last: 2, open24h: 1, volCcy24h: 9e9 },
  { instId: 'EEE-EUR', last: 2, open24h: 1, volCcy24h: 9e9 },
];

describe('coins', () => {
  test('gainers skip thin markets and non-USDT pairs', () => {
    const g = rankCoins(tickers, 'gainers', (b) => (b === 'CCC' ? '씨씨씨' : null));
    expect(g.map((x) => x.key)).toEqual(['coin:BBB-USDT', 'coin:CCC-USDT']);
    expect(g[1]).toMatchObject({ name: '씨씨씨', symbol: 'CCC', price: 1.1, currency: 'USDT', value: 50_000_000 });
    expect(g[0]!.changePct).toBeCloseTo(20);
  });

  test('trading value sorts by 24h quote volume', () => {
    expect(rankCoins(tickers, 'value', () => null).map((x) => x.key)).toEqual(['coin:CCC-USDT', 'coin:BBB-USDT', 'coin:AAA-USDT']);
  });
});

describe('trending service', () => {
  const okx = (calls: { n: number }) => ({ async getTickers() { calls.n++; return tickers; } });
  const instruments = { koreanCoinName: () => null, findKrCode: (name: string) => (name === '삼성전자' ? '005930' : null) };

  test('coin lists are remembered for 60 seconds', async () => {
    const calls = { n: 0 };
    const clock = makeClock();
    const t = createTrending({ okx: okx(calls), kis: null, instruments, now: clock.now });
    await t.get('coin', 'value');
    await t.get('coin', 'gainers');
    expect(calls.n).toBe(1);
    clock.advance(61_000);
    await t.get('coin', 'value');
    expect(calls.n).toBe(2);
  });

  test('stocks need the KIS key; without it the list is empty', async () => {
    const t = createTrending({ okx: okx({ n: 0 }), kis: null, instruments, now: makeClock().now });
    expect(await t.get('kr', 'gainers')).toEqual([]);
  });

  test('Korean rows without a code are matched by name; unknown ones are dropped', async () => {
    const kis = fakeKis({ async getRanking() { return [
      { code: null, symbol: null, exchange: null, name: '삼성전자', price: 70500, changePct: 3, value: null },
      { code: null, symbol: null, exchange: null, name: '모르는회사', price: 1, changePct: 30, value: null },
      { code: '000660', symbol: null, exchange: null, name: 'SK하이닉스', price: 200000, changePct: 2, value: 5 },
    ]; } });
    const t = createTrending({ okx: okx({ n: 0 }), kis, instruments, now: makeClock().now });
    const items = await t.get('kr', 'gainers');
    expect(items.map((i) => i.key)).toEqual(['kr:005930', 'kr:000660']);
    expect(items[0]).toMatchObject({ name: '삼성전자', symbol: '005930', currency: 'KRW' });
  });

  test('US rows become exchange keys', async () => {
    const kis = fakeKis({ async getRanking() { return [{ code: null, symbol: 'NVDA', exchange: 'NAS', name: '엔비디아', price: 180, changePct: 2, value: 9 }]; } });
    const t = createTrending({ okx: okx({ n: 0 }), kis, instruments, now: makeClock().now });
    expect(await t.get('us', 'value')).toEqual([{ key: 'us:NAS:NVDA', name: '엔비디아', symbol: 'NVDA', price: 180, changePct: 2, value: 9, currency: 'USD' }]);
  });
});
