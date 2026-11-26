import { describe, expect, test } from 'vitest';
import { createNaverClient, parseKoNumber, withFallback } from '../../src/market/naver.js';
import { parseInstrumentKey } from '../../src/market/types.js';
import { fakeFetch } from '../fakeFetch.js';

const NOW = Date.parse('2026-11-26T15:00:00+09:00');
const samsung = parseInstrumentKey('kr:005930');
const apple = parseInstrumentKey('us:NAS:AAPL');
const coke = parseInstrumentKey('us:NYS:KO');
const client = (f: typeof fetch) => createNaverClient({ fetch: f, now: () => NOW });

const ac = (code: string, reuters: string) => ({ query: code, items: [{ code, name: 'x', reutersCode: reuters, nationCode: 'USA', category: 'stock' }] });

test('Korean number words become numbers', () => {
  expect(parseKoNumber('1,002조 6,368억')).toBe(1002_6368_0000_0000);
  expect(parseKoNumber('5조 1,674억 USD')).toBe(5_1674_0000_0000);
  expect(parseKoNumber('5.39배')).toBe(5.39);
  expect(parseKoNumber('31,809원')).toBe(31809);
  expect(parseKoNumber('192억 USD')).toBe(192e8);
  expect(parseKoNumber('N/A')).toBeNull();
  expect(parseKoNumber('')).toBeNull();
});

describe('quotes', () => {
  test('Korean stock from the realtime endpoint; falling prices are negative', async () => {
    const f = fakeFetch({ '/api/realtime/domestic/stock/005930': () => ({ datas: [{ itemCode: '005930', closePrice: '171,500', fluctuationsRatio: '0.62', compareToPreviousPrice: { code: '5' } }] }) });
    const q = await client(f).getQuote(samsung);
    expect(q).toMatchObject({ price: 171500, changePct24h: -0.62, currency: 'KRW' });
  });

  test('US stock symbols are resolved to Naver codes once (NYSE has no fixed suffix)', async () => {
    const f = fakeFetch({
      '/ac': (url) => ac(url.searchParams.get('q')!, url.searchParams.get('q') === 'KO' ? 'KO' : 'AAPL.O'),
      '/api/realtime/worldstock/stock/KO': () => ({ datas: [{ reutersCode: 'KO', closePrice: '70.12', fluctuationsRatio: '-1.10', compareToPreviousPrice: { code: '5' } }] }),
      '/api/realtime/worldstock/stock/AAPL.O': () => ({ datas: [{ reutersCode: 'AAPL.O', closePrice: '355.58', fluctuationsRatio: '0.43', compareToPreviousPrice: { code: '2' } }] }),
    });
    const c = client(f);
    expect(await c.getQuote(coke)).toMatchObject({ price: 70.12, changePct24h: -1.1, currency: 'USD' });
    await c.getQuote(coke);
    expect(f.count('/ac')).toBe(1);
    expect((await c.getQuote(apple)).price).toBe(355.58);
  });

  test('an empty answer is an error', async () => {
    const f = fakeFetch({ '/api/realtime/domestic/stock/005930': () => ({ datas: [] }) });
    await expect(client(f).getQuote(samsung)).rejects.toThrow();
  });
});

describe('candles', () => {
  test('Korean daily candles are oldest first at KST midnight', async () => {
    const f = fakeFetch({ '/chart/domestic/item/005930/day': () => [
      { localDate: '20261125', openPrice: 170000, highPrice: 172000, lowPrice: 169000, closePrice: 170700, accumulatedTradingVolume: 100 },
      { localDate: '20261126', openPrice: 170600, highPrice: 176700, lowPrice: 170600, closePrice: 171500, accumulatedTradingVolume: 200 },
    ] });
    const c = await client(f).getCandles(samsung, '1D', 2);
    expect(c.map((x) => x.time)).toEqual([Date.parse('2026-11-25T00:00:00+09:00') / 1000, Date.parse('2026-11-26T00:00:00+09:00') / 1000]);
    expect(c[1]).toMatchObject({ open: 170600, high: 176700, low: 170600, close: 171500, volume: 200 });
  });

  test('Korean 5-minute candles are built from 1-minute data', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ localDateTime: `202611260${9}0${i}00`, openPrice: 100 + i, highPrice: 110 + i, lowPrice: 90 + i, currentPrice: 105 + i, accumulatedTradingVolume: 10 }));
    const f = fakeFetch({ '/chart/domestic/item/005930/minute': () => rows });
    const c = await client(f).getCandles(samsung, '5m', 10);
    expect(c).toHaveLength(2);
    expect(c[0]).toMatchObject({ time: Date.parse('2026-11-26T09:00:00+09:00') / 1000, open: 100, high: 114, low: 90, close: 109, volume: 50 });
  });

  test('US 5-minute candles come from Yahoo (Naver has no US minutes)', async () => {
    const f = fakeFetch({
      '/v8/finance/chart/AAPL': (url) => {
        expect(url.searchParams.get('interval')).toBe('5m');
        return { chart: { result: [{ timestamp: [1795640100, 1795640400], indicators: { quote: [{ open: [1, 2], high: [3, 4], low: [0.5, 1.5], close: [2, null], volume: [10, 20] }] } }] } };
      },
    });
    const c = await client(f).getCandles(apple, '5m', 10);
    expect(c).toEqual([{ time: 1795640100, open: 1, high: 3, low: 0.5, close: 2, volume: 10 }]);
  });
});

describe('rankings', () => {
  const kr = (code: string, name: string, ratio: string, value: string, end = 'stock') => ({ itemCode: code, stockName: name, closePrice: '1,000', fluctuationsRatio: ratio, accumulatedTradingValue: value, stockEndType: end, compareToPreviousPrice: { code: ratio.startsWith('-') ? '5' : '2' } });

  test('Korean gainers merge KOSPI and KOSDAQ, stocks only', async () => {
    const f = fakeFetch({
      '/api/stocks/up/KOSPI': () => ({ stocks: [kr('111111', '코스피급등', '20.5', '500'), kr('700032', 'ETN', '33.7', '1', 'etn')] }),
      '/api/stocks/up/KOSDAQ': () => ({ stocks: [kr('222222', '코스닥급등', '29.9', '300')] }),
    });
    const r = await client(f).getRanking('kr', 'gainers');
    expect(r.map((x) => x.name)).toEqual(['코스닥급등', '코스피급등']);
    expect(r[0]).toMatchObject({ code: '222222', changePct: 29.9, value: 300e6, price: 1000 });
  });

  test('US trading value: three exchanges, big companies, Naver codes remembered', async () => {
    const us = (sym: string, reuters: string, ex: string, value: string, mv: string) => ({ symbolCode: sym, reutersCode: reuters, stockName: sym, closePrice: '10', fluctuationsRatio: '1.0', accumulatedTradingValue: value, marketValue: mv, stockEndType: 'stock', stockExchangeType: { code: ex }, compareToPreviousPrice: { code: '2' } });
    const f = fakeFetch({
      '/stock/exchange/NASDAQ/marketValue': () => ({ stocks: [us('AAPL', 'AAPL.O', 'NSQ', '192억 USD', '5,167,353,276')] }),
      '/stock/exchange/NYSE/marketValue': () => ({ stocks: [us('DELL', 'DELL.K', 'NYS', '75.3억 USD', '188,874,536')] }),
      '/stock/exchange/AMEX/marketValue': () => ({ stocks: [] }),
      '/api/realtime/worldstock/stock/DELL.K': () => ({ datas: [{ closePrice: '297.06', fluctuationsRatio: '0.60', compareToPreviousPrice: { code: '2' } }] }),
    });
    const c = client(f);
    const r = await c.getRanking('us', 'value');
    expect(r.map((x) => `${x.exchange}:${x.symbol}`)).toEqual(['NAS:AAPL', 'NYS:DELL']);
    expect(r[0]!.value).toBe(192e8);
    // 순위에서 본 DELL.K는 다시 찾지 않는다
    expect((await c.getQuote(parseInstrumentKey('us:NYS:DELL'))).price).toBe(297.06);
    expect(f.count('/ac')).toBe(0);
  });
});

test('indices: KOSPI, KOSDAQ, S&P 500 and NASDAQ Composite', async () => {
  const f = fakeFetch({
    '/api/realtime/domestic/index/KOSPI': () => ({ datas: [{ closePrice: '4,711.21', fluctuationsRatio: '0.29', compareToPreviousPrice: { code: '2' } }] }),
    '/api/realtime/worldstock/index/.INX': () => ({ datas: [{ closePrice: '6,912.10', fluctuationsRatio: '-0.31', compareToPreviousPrice: { code: '5' } }] }),
  });
  const c = client(f);
  expect(await c.getIndex('0001')).toEqual({ value: 4711.21, changePct: 0.29 });
  expect(await c.getUsIndex('SPX')).toEqual({ value: 6912.1, changePct: -0.31 });
});

test('fundamentals from Naver (Korean 조/억 and US USD)', async () => {
  const f = fakeFetch({
    '/api/stock/005930/integration': () => ({ totalInfos: [
      { code: 'marketValue', value: '1,002조 6,368억' }, { code: 'per', value: '5.39배' }, { code: 'pbr', value: '1.85배' },
      { code: 'eps', value: '31,809원' }, { code: 'highPriceOf52Weeks', value: '380,000' }, { code: 'lowPriceOf52Weeks', value: '99,900' },
    ] }),
    '/ac': () => ac('AAPL', 'AAPL.O'),
    '/stock/AAPL.O/basic': () => ({ stockItemTotalInfos: [
      { code: 'marketValue', value: '5조 1,674억 USD' }, { code: 'per', value: '39.62배' }, { code: 'pbr', value: '46.10배' },
      { code: 'eps', value: '8.97' }, { code: 'highPriceOf52Weeks', value: '360.83' }, { code: 'lowPriceOf52Weeks', value: '243.42' },
    ] }),
  });
  const c = client(f);
  expect(await c.getBasicInfo(samsung)).toEqual({ marketCap: 1002_6368_0000_0000, per: 5.39, pbr: 1.85, eps: 31809, high52: 380000, low52: 99900, currency: 'KRW' });
  expect(await c.getBasicInfo(apple)).toEqual({ marketCap: 5_1674_0000_0000, per: 39.62, pbr: 46.1, eps: 8.97, high52: 360.83, low52: 243.42, currency: 'USD' });
});

test('withFallback uses the first source and falls back on errors', async () => {
  const kisLike = { getQuote: async () => { throw new Error('kis down'); }, ok: async () => 'kis' };
  const naverLike = { getQuote: async () => 'naver', ok: async () => 'naver' };
  const s = withFallback(kisLike as never, naverLike as never, ['getQuote', 'ok'] as never) as unknown as { getQuote(): Promise<string>; ok(): Promise<string> };
  expect(await s.getQuote()).toBe('naver');
  expect(await s.ok()).toBe('kis');
});
