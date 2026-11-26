import { describe, expect, test } from 'vitest';
import { createOkxClient, okxSign, OkxError } from '../../src/market/okx.js';
import { fakeFetch } from '../fakeFetch.js';

const creds = { key: 'k', secret: 'secret', passphrase: 'pp' };
const ok = (data: unknown) => ({ code: '0', msg: '', data });

// OKX 캔들: 최신 → 오래된 순, [ts, o, h, l, c, vol, volCcy, volCcyQuote, confirm]
const candleRows = [
  ['1700010800000', '103', '106', '101', '105', '30', '0', '0', '0'],
  ['1700007200000', '102', '104', '100', '103', '20', '0', '0', '1'],
  ['1700003600000', '100', '103', '99', '102', '10', '0', '0', '1'],
];

test('okxSign matches known vector', () => {
  expect(okxSign('secret', '2020-12-08T09:08:57.715Z', 'GET', '/api/v5/account/balance?ccy=BTC', ''))
    .toBe('wpDvCwYCprcMQsQkxWJiWy+YADoQE4ep+OEKKLimMoY=');
});

describe('market data', () => {
  test('candles are oldest-first, numeric, and use 1Dutc for daily', async () => {
    const f = fakeFetch({ '/api/v5/market/candles': () => ok(candleRows) });
    const c = await createOkxClient({ creds: null, fetchImpl: f }).getCandles('BTC-USDT', '1D', 3);
    expect(f.calls[0]!.url.searchParams.get('bar')).toBe('1Dutc');
    expect(f.calls[0]!.url.searchParams.get('instId')).toBe('BTC-USDT');
    expect(c.map((x) => x.time)).toEqual([1700003600, 1700007200, 1700010800]);
    expect(c[2]).toEqual({ time: 1700010800, open: 103, high: 106, low: 101, close: 105, volume: 30 });
  });

  test('weekly maps to 1Wutc and 4H stays 4H', async () => {
    const f = fakeFetch({ '/api/v5/market/candles': () => ok(candleRows) });
    const client = createOkxClient({ creds: null, fetchImpl: f });
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
    const c = await createOkxClient({ creds: null, fetchImpl: f }).getCandles('BTC-USDT', '1H', 400);
    expect(c).toHaveLength(400);
    expect(c[0]!.time).toBe(601 * 3600);
    expect(c.at(-1)!.time).toBe(1000 * 3600);
  });

  test('quote computes 24h change from open24h', async () => {
    const f = fakeFetch({ '/api/v5/market/ticker': () => ok([{ instId: 'BTC-USDT', last: '96000', open24h: '100000', ts: '1700000000000' }]) });
    const q = await createOkxClient({ creds: null, fetchImpl: f }).getQuote('BTC-USDT');
    expect(q).toMatchObject({ price: 96000, currency: 'USDT', time: 1700000000 });
    expect(q.changePct24h).toBeCloseTo(-4, 6);
    expect(q.instrument).toMatchObject({ market: 'coin', symbol: 'BTC-USDT', kind: 'spot' });
  });

  test('non-zero code throws OkxError', async () => {
    const f = fakeFetch({ '/api/v5/market/ticker': () => ({ code: '51001', msg: 'Instrument ID does not exist', data: [] }) });
    await expect(createOkxClient({ creds: null, fetchImpl: f }).getQuote('NOPE-USDT')).rejects.toBeInstanceOf(OkxError);
  });
});

describe('holdings', () => {
  function holdingsFetch(positions: unknown[], balance: unknown[] = []) {
    return fakeFetch({
      '/api/v5/account/balance': () => ok([{ details: balance }]),
      '/api/v5/account/positions': () => ok(positions),
      '/api/v5/public/funding-rate': (url) => ok([{ instId: url.searchParams.get('instId'), fundingRate: '0.0001' }]),
      '/api/v5/public/instruments': (url) => ok([{ instId: url.searchParams.get('instId'), ctVal: url.searchParams.get('instId')?.startsWith('BTC') ? '0.01' : '0.1' }]),
    });
  }

  test('no creds → holdings [] without calling private API', async () => {
    const f = holdingsFetch([]);
    expect(await createOkxClient({ creds: null, fetchImpl: f }).getHoldings()).toEqual([]);
    expect(f.calls).toHaveLength(0);
  });

  test('private requests are signed with OKX headers', async () => {
    const f = holdingsFetch([]);
    await createOkxClient({ creds, fetchImpl: f, now: () => new Date('2020-12-08T09:08:57.715Z') }).getHoldings();
    const balanceCall = f.calls.find((c) => c.url.pathname === '/api/v5/account/balance')!;
    const h = new Headers(balanceCall.init?.headers);
    expect(h.get('OK-ACCESS-KEY')).toBe('k');
    expect(h.get('OK-ACCESS-PASSPHRASE')).toBe('pp');
    expect(h.get('OK-ACCESS-TIMESTAMP')).toBe('2020-12-08T09:08:57.715Z');
    expect(h.get('OK-ACCESS-SIGN')).toBe(okxSign('secret', '2020-12-08T09:08:57.715Z', 'GET', '/api/v5/account/balance', ''));
  });

  test('net-mode position direction from sign, quantity in coins via ctVal', async () => {
    const f = holdingsFetch([{ instId: 'BTC-USDT-SWAP', posSide: 'net', pos: '-3', avgPx: '97000', lever: '10', liqPx: '105000', markPx: '96420', upl: '17.4' }]);
    const [h] = await createOkxClient({ creds, fetchImpl: f }).getHoldings();
    expect(h).toMatchObject({
      side: 'short', quantity: 0.03, avgPrice: 97000, leverage: 10, liqPrice: 105000, markPrice: 96420,
      unrealizedPnl: 17.4, fundingRate: 0.0001, currency: 'USDT', source: 'okx',
    });
    expect(h!.instrument).toMatchObject({ market: 'coin', symbol: 'BTC-USDT-SWAP', kind: 'swap' });
  });

  test('long/short mode positions and empty liqPx becomes null', async () => {
    const f = holdingsFetch([{ instId: 'ETH-USDT-SWAP', posSide: 'long', pos: '5', avgPx: '3400', lever: '5', liqPx: '', markPx: '3470', upl: '35' }]);
    const [h] = await createOkxClient({ creds, fetchImpl: f }).getHoldings();
    expect(h).toMatchObject({ side: 'long', quantity: 0.5, liqPrice: null });
  });

  test('zero positions are skipped', async () => {
    const f = holdingsFetch([{ instId: 'SOL-USDT-SWAP', posSide: 'net', pos: '0', avgPx: '', lever: '3', liqPx: '', markPx: '200', upl: '0' }]);
    expect(await createOkxClient({ creds, fetchImpl: f }).getHoldings()).toEqual([]);
  });

  test('spot balances ≥ 1 USD become spot holdings, USDT excluded', async () => {
    const f = holdingsFetch([], [
      { ccy: 'ETH', eq: '2', eqUsd: '6940', accAvgPx: '3000', openAvgPx: '3100' },
      { ccy: 'USDT', eq: '500', eqUsd: '500' },
      { ccy: 'DOGE', eq: '1', eqUsd: '0.3' },
      { ccy: 'SOL', eq: '4', eqUsd: '840', accAvgPx: '', openAvgPx: '' },
    ]);
    const hs = await createOkxClient({ creds, fetchImpl: f }).getHoldings();
    expect(hs.map((h) => h.instrument.symbol)).toEqual(['ETH-USDT', 'SOL-USDT']);
    expect(hs[0]).toMatchObject({ quantity: 2, avgPrice: 3000, side: null, leverage: null, instrument: { kind: 'spot' } });
    expect(hs[1]!.avgPrice).toBe(0);
  });
});

test('unsupported OKX products are skipped instead of failing all holdings', async () => {
  const f = fakeFetch({
    '/api/v5/account/balance': () => ok([{ details: [] }]),
    '/api/v5/account/positions': () => ok([
      { instId: 'BTC-USDT-261225', posSide: 'net', pos: '1', avgPx: '1', lever: '5', liqPx: '', markPx: '1', upl: '0' },
      { instId: 'ETH-USDT-SWAP', posSide: 'long', pos: '5', avgPx: '3400', lever: '5', liqPx: '3000', markPx: '3470', upl: '35' },
    ]),
    '/api/v5/public/funding-rate': () => ok([{ fundingRate: '0.0001' }]),
    '/api/v5/public/instruments': () => ok([{ ctVal: '0.1' }]),
  });
  const client = createOkxClient({ creds, fetchImpl: f });
  const hs = await client.getHoldings();
  expect(hs.map((h) => h.instrument.symbol)).toEqual(['ETH-USDT-SWAP']);
  expect(client.unsupported()).toEqual(['BTC-USDT-261225']);
});
