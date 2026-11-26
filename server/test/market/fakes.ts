import type { KisClient } from '../../src/market/kis.js';
import type { OkxClient } from '../../src/market/okx.js';
import { parseInstrumentKey, type Bar, type Candle } from '../../src/market/types.js';

const H = 3600;

export function series(endSec: number, n: number, step = H): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const t = endSec - (n - 1 - i) * step;
    return { time: t, open: 1, high: 2, low: 0.5, close: 1 + i, volume: 10 };
  });
}

export function fakeOkx(over: Partial<OkxClient> = {}) {
  const calls: { instId: string; bar: Bar; limit: number }[] = [];
  const okx: OkxClient & { calls: typeof calls } = {
    calls,
    async getCandles(instId, bar, limit) { calls.push({ instId, bar, limit }); return series(Math.floor(Date.UTC(2026, 10, 26) / 1000), limit); },
    async getQuote(instId) { return { instrument: parseInstrumentKey(`coin:${instId}`), price: 100, changePct24h: 1, currency: 'USDT', time: 0 }; },
    async getFundingRate() { return null; },
    ...over,
  };
  return okx;
}

export function fakeKis(over: Partial<KisClient> = {}): KisClient {
  return {
    async getCandles() { return []; },
    async getQuote(inst) { return { instrument: inst, price: inst.market === 'kr' ? 70000 : 200, changePct24h: 0, currency: inst.market === 'kr' ? 'KRW' : 'USD', time: 0 }; },
    ...over,
  };
}

