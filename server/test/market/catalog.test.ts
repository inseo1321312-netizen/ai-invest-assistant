import { describe, expect, test } from 'vitest';
import { createInstrumentCatalog } from '../../src/market/catalog.js';
import { createUpbitClient } from '../../src/market/upbit.js';
import { fakeFetch } from '../fakeFetch.js';
import { makeClock } from '../helpers.js';

const masters = async () => ({
  kr: [
    { code: '005930', name: '삼성전자', group: 'ST' },
    { code: '006400', name: '삼성SDI', group: 'ST' },
    { code: '207940', name: '삼성바이오로직스', group: 'ST' },
    { code: '000660', name: 'SK하이닉스', group: 'ST' },
  ],
  us: [
    { symbol: 'AAPL', exchange: 'NAS' as const, koName: '애플', enName: 'APPLE INC' },
    { symbol: 'AAPU', exchange: 'NAS' as const, koName: '디렉시온 애플 2배', enName: 'DIREXION AAPL BULL 2X' },
  ],
});

const tickers = async () => [
  { instId: 'BTC-USDT', last: 60000, open24h: 59000, volCcy24h: 900_000_000 },
  { instId: 'BTT-USDT', last: 0.000001, open24h: 0.000001, volCcy24h: 2_000_000 },
  { instId: 'ETH-USDT', last: 3000, open24h: 3100, volCcy24h: 500_000_000 },
  { instId: 'BTC-USDC', last: 60000, open24h: 59000, volCcy24h: 100 },
];
const upbit = { markets: async () => [
  { market: 'KRW-BTC', koreanName: '비트코인', englishName: 'Bitcoin', warning: false, cautions: [] },
  { market: 'KRW-BTT', koreanName: '비트토렌트', englishName: 'BitTorrent', warning: false, cautions: [] },
  { market: 'KRW-ETH', koreanName: '이더리움', englishName: 'Ethereum', warning: false, cautions: [] },
] };

function make(over: { loadMasters?: () => Promise<Awaited<ReturnType<typeof masters>>> } = {}) {
  const clock = makeClock();
  return createInstrumentCatalog({ now: clock.now, loadMasters: over.loadMasters ?? masters, okx: { getTickers: tickers }, upbit });
}

describe('search', () => {
  test('a part of a Korean name finds the stock; spaces are ignored', async () => {
    const c = make();
    const hits = await c.search('삼');
    expect(hits.slice(0, 3).map((h) => h.name)).toEqual(['삼성전자', '삼성SDI', '삼성바이오로직스']); // 같은 단계면 짧은 이름 먼저
    expect((await c.search('삼 성 전'))[0]).toEqual({ key: 'kr:005930', market: 'kr', name: '삼성전자', symbol: '005930' });
  });

  test('ticker in lower case finds the exact US stock first', async () => {
    const hits = await make().search('aapl');
    expect(hits[0]).toEqual({ key: 'us:NAS:AAPL', market: 'us', name: '애플', symbol: 'AAPL' });
  });

  test('Korean coin names come from Upbit; bigger volume first', async () => {
    const hits = await make().search('비트');
    expect(hits.map((h) => h.key)).toEqual(['coin:BTC-USDT', 'coin:BTT-USDT']);
    expect(hits[0]!.name).toBe('비트코인');
  });

  test('empty query gives nothing', async () => {
    expect(await make().search('  ')).toEqual([]);
  });

  test('coins still work when the stock lists cannot be downloaded', async () => {
    const c = make({ loadMasters: async () => { throw new Error('down'); } });
    expect((await c.search('ETH'))[0]!.key).toBe('coin:ETH-USDT');
    expect(await c.search('삼성')).toEqual([]);
  });

  test('nameOf gives display names after loading', async () => {
    const c = make();
    expect(c.nameOf('kr:005930')).toBeNull();
    await c.warm();
    expect(c.nameOf('kr:005930')).toBe('삼성전자');
    expect(c.nameOf('us:NAS:AAPL')).toBe('애플');
    expect(c.nameOf('coin:BTC-USDT')).toBe('비트코인');
    expect(c.nameOf('coin:BTC-USDT-SWAP')).toBe('비트코인');
    expect(c.koreanCoinName('ETH')).toBe('이더리움');
  });
});

describe('upbit client', () => {
  test('markets list warnings and only active cautions; KRW prices by base symbol', async () => {
    const f = fakeFetch({
      '/v1/market/all': (url) => {
        expect(url.searchParams.get('isDetails')).toBe('true');
        return [{ market: 'KRW-BTC', korean_name: '비트코인', english_name: 'Bitcoin', market_event: { warning: true, caution: { PRICE_FLUCTUATIONS: true, TRADING_VOLUME_SOARING: false } } }];
      },
      '/v1/ticker/all': () => [{ market: 'KRW-BTC', trade_price: 82625000 }, { market: 'KRW-ETH', trade_price: 4000000 }],
    });
    const u = createUpbitClient({ fetch: f });
    expect(await u.markets()).toEqual([{ market: 'KRW-BTC', koreanName: '비트코인', englishName: 'Bitcoin', warning: true, cautions: ['PRICE_FLUCTUATIONS'] }]);
    const p = await u.krwPrices();
    expect(p.get('BTC')).toBe(82625000);
    expect(p.get('ETH')).toBe(4000000);
  });
});

test('findKrCode looks up a Korean stock by exact name', async () => {
  const c = make();
  await c.warm();
  expect(c.findKrCode('삼성전자')).toBe('005930');
  expect(c.findKrCode('없는회사')).toBeNull();
});
