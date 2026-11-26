import { describe, expect, test } from 'vitest';
import { createOkxClient, OkxError } from '../../src/market/okx.js';
import { fakeFetch } from '../fakeFetch.js';

const ok = (data: unknown) => ({ code: '0', msg: '', data });

// OKX 캔들: 최신 → 오래된 순, [ts, o, h, l, c, vol, volCcy, volCcyQuote, confirm]
const candleRows = [
  ['1700010800000', '103', '106', '101', '105', '30', '0', '0', '0'],
  ['1700007200000', '102', '104', '100', '103', '20', '0', '0', '1'],
  ['1700003600000', '100', '103', '99', '102', '10', '0', '0', '1'],
];

describe('market data', () => {
  test('candles are oldest-first, numeric, and use 1Dutc for daily', async () => {
    const f = fakeFetch({ '/api/v5/market/candles': () => ok(candleRows) });
    const c = await createOkxClient({ fetchImpl: f }).getCandles('BTC-USDT', '1D', 3);
    expect(f.calls[0]!.url.searchParams.get('bar')).toBe('1Dutc');
    expect(f.calls[0]!.url.searchParams.get('instId')).toBe('BTC-USDT');
    expect(c.map((x) => x.time)).toEqual([1700003600, 1700007200, 1700010800]);
    expect(c[2]).toEqual({ time: 1700010800, open: 103, high: 106, low: 101, close: 105, volume: 30 });
  });

  test('weekly maps to 1Wutc and 4H stays 4H', async () => {
    const f = fakeFetch({ '/api/v5/market/candles': () => ok(candleRows) });
    const client = createOkxClient({ fetchImpl: f });
    await client.getCandles('BTC-USDT', '1W', 3);
    await client.getCandles('BTC-USDT', '4H', 3);
    expect(f.calls.map((c) => c.url.searchParams.get('bar'))).toEqual(['1Wutc', '4H']);
  });

  test('more than 300 candles pages through history-candles', async () => {
    const page1 = Array.from({ length: 300 }, (_, i) => [String((1000 - i) * 3600_000), '1', '1', '1', '1', '1', '0', '0', '1']);
    const page2 = Array.from({ length: 100 }, (_, i) => [String((700 - i) * 3600_000), '1', '1', '1', '1', '1', '0', '0', '1']);
    const f = fakeFetch({
      '/api/v5/market/candles': () => ok(page1),
      '/api/v5/market/history-candles': (url) => {
        expect(url.searchParams.get('after')).toBe(String(701 * 3600_000));
        return ok(page2);
      },
    });
    const c = await createOkxClient({ fetchImpl: f }).getCandles('BTC-USDT', '1H', 400);
    expect(c).toHaveLength(400);
    expect(c[0]!.time).toBe(601 * 3600);
    expect(c.at(-1)!.time).toBe(1000 * 3600);
  });

  test('quote computes 24h change from open24h', async () => {
    const f = fakeFetch({ '/api/v5/market/ticker': () => ok([{ instId: 'BTC-USDT', last: '96000', open24h: '100000', ts: '1700000000000' }]) });
    const q = await createOkxClient({ fetchImpl: f }).getQuote('BTC-USDT');
    expect(q).toMatchObject({ price: 96000, currency: 'USDT', time: 1700000000 });
    expect(q.changePct24h).toBeCloseTo(-4, 6);
    expect(q.instrument).toMatchObject({ market: 'coin', symbol: 'BTC-USDT', kind: 'spot' });
  });

  test('non-zero code throws OkxError', async () => {
    const f = fakeFetch({ '/api/v5/market/ticker': () => ({ code: '51001', msg: 'Instrument ID does not exist', data: [] }) });
    await expect(createOkxClient({ fetchImpl: f }).getQuote('NOPE-USDT')).rejects.toBeInstanceOf(OkxError);
  });
});


test('tickers give last, open and quote volume as numbers', async () => {
  const f = fakeFetch({ '/api/v5/market/tickers': (url) => {
    expect(url.searchParams.get('instType')).toBe('SPOT');
    return ok([{ instId: 'BTC-USDT', last: '60000', open24h: '59000', volCcy24h: '900000000' }]);
  } });
  expect(await createOkxClient({ fetchImpl: f }).getTickers('SPOT')).toEqual([{ instId: 'BTC-USDT', last: 60000, open24h: 59000, volCcy24h: 900000000 }]);
});
