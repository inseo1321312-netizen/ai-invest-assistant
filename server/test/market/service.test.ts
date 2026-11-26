import { describe, expect, test } from 'vitest';
import { openDb } from '../../src/db.js';
import { getUsdKrw } from '../../src/market/fx.js';
import { createMarketService } from '../../src/market/service.js';
import { parseInstrumentKey, type Bar, type Candle, type Holding } from '../../src/market/types.js';
import { makeClock } from '../helpers.js';
import { fakeFetch } from '../fakeFetch.js';
import { fakeKis, fakeOkx, series } from './fakes.js';

const holding = (key: string, extra: Partial<Holding> = {}): Holding => ({
  instrument: parseInstrumentKey(key), quantity: 1, avgPrice: 100, currency: 'USDT', source: 'okx',
  side: null, leverage: null, liqPrice: null, markPrice: null, unrealizedPnl: null, fundingRate: null, ...extra,
});

function setup(okx = fakeOkx(), kis = fakeKis(), fx = async () => 1400 as number | null) {
  const clock = makeClock(Date.UTC(2026, 10, 26, 0, 30));
  const db = openDb(':memory:');
  const svc = createMarketService({ okx, kis, db, now: clock.now, fx });
  return { svc, clock, okx, db };
}

describe('candle cache', () => {
  const btc = parseInstrumentKey('coin:BTC-USDT');

  test('within TTL returns cache without fetching', async () => {
    const { svc, okx } = setup();
    await svc.getCandles(btc, '1H', 100);
    await svc.getCandles(btc, '1H', 100);
    expect(okx.calls).toHaveLength(1);
  });

  test('closed candles are not refetched: after TTL only recent candles requested', async () => {
    const { svc, okx, clock } = setup();
    const first = await svc.getCandles(btc, '1H', 100);
    expect(first).toHaveLength(100);
    clock.advance(3 * 60 * 1000);
    const second = await svc.getCandles(btc, '1H', 100);
    expect(okx.calls).toHaveLength(2);
    expect(okx.calls[1]!.limit).toBeLessThanOrEqual(5);
    expect(second).toHaveLength(100);
    expect(second.map((c) => c.time)).toEqual([...second.map((c) => c.time)].sort((a, b) => a - b));
  });

  test('asking for more than cached triggers full fetch', async () => {
    const { svc, okx, clock } = setup();
    await svc.getCandles(btc, '1H', 50);
    clock.advance(3 * 60 * 1000);
    await svc.getCandles(btc, '1H', 200);
    expect(okx.calls[1]!.limit).toBe(200);
  });

  test('stocks route to KIS', async () => {
    let asked = '';
    const kis = fakeKis({ async getCandles(inst) { asked = inst.symbol; return series(1_700_000_000, 3, 86400); } });
    const { svc } = setup(fakeOkx(), kis);
    const c = await svc.getCandles(parseInstrumentKey('kr:005930'), '1D', 3);
    expect(asked).toBe('005930');
    expect(c).toHaveLength(3);
  });
});

describe('holdings and watchlist', () => {
  test('merges auto and manual holdings with source', async () => {
    const okx = fakeOkx({ async getHoldings() { return [holding('coin:BTC-USDT-SWAP', { side: 'short', leverage: 10 })]; } });
    const { svc } = setup(okx);
    svc.addManualHolding({ key: 'coin:ETH-USDT', quantity: 2, avgPrice: 3000, side: null, leverage: null });
    const hs = await svc.getHoldings('coin');
    expect(hs.map((h) => [h.instrument.symbol, h.source])).toEqual([['BTC-USDT-SWAP', 'okx'], ['ETH-USDT', 'manual']]);
    expect(hs[1]).toMatchObject({ quantity: 2, avgPrice: 3000, currency: 'USDT' });
  });

  test('kis holdings are split by market', async () => {
    const kis = fakeKis({ async getHoldings() { return [holding('kr:005930', { currency: 'KRW', source: 'kis' }), holding('us:NAS:AAPL', { currency: 'USD', source: 'kis' })]; } });
    const { svc } = setup(fakeOkx(), kis);
    expect((await svc.getHoldings('kr')).map((h) => h.instrument.symbol)).toEqual(['005930']);
    expect((await svc.getHoldings('us')).map((h) => h.instrument.symbol)).toEqual(['AAPL']);
  });

  test('manual holding removal and watchlist CRUD', async () => {
    const { svc } = setup();
    const id = svc.addManualHolding({ key: 'kr:005930', quantity: 1, avgPrice: 1, side: null, leverage: null });
    svc.removeManualHolding(id);
    expect(await svc.getHoldings('kr')).toEqual([]);
    svc.addWatch('coin:SOL-USDT');
    svc.addWatch('coin:SOL-USDT');
    svc.addWatch('us:NAS:NVDA');
    expect(svc.listWatchlist('coin').map((i) => i.symbol)).toEqual(['SOL-USDT']);
    svc.removeWatch('coin:SOL-USDT');
    expect(svc.listWatchlist('coin')).toEqual([]);
  });
});

describe('fx', () => {
  test('caches for 6 hours and falls back to last cached value on failure', async () => {
    const db = openDb(':memory:');
    const clock = makeClock();
    let fail = false;
    const f = fakeFetch({ '/v1/latest': () => (fail ? new Response('down', { status: 500 }) : { rates: { KRW: 1400.5 } }) });
    expect(await getUsdKrw({ db, fetchImpl: f, now: clock.now })).toBe(1400.5);
    expect(await getUsdKrw({ db, fetchImpl: f, now: clock.now })).toBe(1400.5);
    expect(f.calls).toHaveLength(1);
    clock.advance(7 * 3600 * 1000);
    fail = true;
    expect(await getUsdKrw({ db, fetchImpl: f, now: clock.now })).toBe(1400.5);
    expect(f.calls).toHaveLength(2);
  });

  test('no cache and failure → null', async () => {
    const f = fakeFetch({ '/v1/latest': () => new Response('down', { status: 500 }) });
    expect(await getUsdKrw({ db: openDb(':memory:'), fetchImpl: f, now: Date.now })).toBeNull();
  });
});
