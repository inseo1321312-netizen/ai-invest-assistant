import { describe, expect, test } from 'vitest';
import { openDb } from '../../src/db.js';
import { getUsdKrw } from '../../src/market/fx.js';
import { createMarketService } from '../../src/market/service.js';
import { parseInstrumentKey, type Bar, type Candle } from '../../src/market/types.js';
import { makeClock } from '../helpers.js';
import { fakeFetch } from '../fakeFetch.js';
import { fakeKis, fakeOkx, series } from './fakes.js';

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

describe('favorites', () => {
  test('watchlist CRUD keeps one row per key and filters by market', () => {
    const { svc } = setup();
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
