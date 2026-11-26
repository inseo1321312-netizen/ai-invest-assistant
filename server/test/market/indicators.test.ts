import { describe, expect, test } from 'vitest';
import { bollinger, ema, macd, rsi, sma, summarizeIndicators } from '../../src/market/indicators.js';
import { HORIZON_BARS, instrumentKey, parseInstrumentKey, type Candle } from '../../src/market/types.js';

function candles(n: number): Candle[] {
  return Array.from({ length: n }, (_, i) => ({ time: 1_700_000_000 + i * 3600, open: 10 + i, high: 11 + i, low: 9 + i, close: 10 + i, volume: 100 }));
}

test('sma', () => {
  expect(sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
});

test('ema seeded with sma', () => {
  expect(ema([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
});

describe('rsi', () => {
  test('strictly rising → 100', () => {
    expect(rsi([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], 14).at(-1)).toBe(100);
  });
  test('flat → 50', () => {
    expect(rsi(Array(20).fill(7), 14).at(-1)).toBe(50);
  });
  test('strictly falling → 0', () => {
    expect(rsi([16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1], 14).at(-1)).toBe(0);
  });
  test('first period values are null', () => {
    const r = rsi([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], 14);
    expect(r.slice(0, 14).every((v) => v === null)).toBe(true);
    expect(r).toHaveLength(16);
  });
});

test('bollinger uses population std dev', () => {
  const bb = bollinger([1, 2, 3, 4, 5], 5, 2);
  expect(bb.mid.at(-1)).toBe(3);
  expect(bb.upper.at(-1)).toBeCloseTo(5.82843, 4);
  expect(bb.lower.at(-1)).toBeCloseTo(0.17157, 4);
  expect(bb.mid[0]).toBeNull();
});

test('macd of flat series is zero', () => {
  const m = macd(Array(60).fill(10));
  expect(m.macd.at(-1)).toBe(0);
  expect(m.signal.at(-1)).toBe(0);
  expect(m.hist.at(-1)).toBe(0);
  expect(m.macd).toHaveLength(60);
});

test('returns nulls when not enough data', () => {
  const c = candles(5);
  const s = summarizeIndicators(c);
  expect(s.sma20).toBeNull();
  expect(s.rsi14).toBeNull();
  expect(s.macd).toBeNull();
  expect(s.lastClose).toBe(14);
  expect(s.lastCandleTime).toBe(c.at(-1)!.time);
  expect(Object.values(s).some((v) => typeof v === 'number' && Number.isNaN(v))).toBe(false);
});

test('summary with enough data has numbers', () => {
  const s = summarizeIndicators(candles(100));
  expect(s.sma20).toBeCloseTo(99.5, 6);
  expect(s.volumeVsAvg20).toBe(1);
  expect(typeof s.rsi14).toBe('number');
});

test('summary of empty candles is all null', () => {
  const s = summarizeIndicators([]);
  expect(s.lastClose).toBeNull();
  expect(s.lastCandleTime).toBeNull();
});

test('instrument keys roundtrip', () => {
  expect(instrumentKey(parseInstrumentKey('us:NAS:AAPL'))).toBe('us:NAS:AAPL');
  expect(instrumentKey(parseInstrumentKey('kr:005930'))).toBe('kr:005930');
  expect(instrumentKey(parseInstrumentKey('coin:BTC-USDT-SWAP'))).toBe('coin:BTC-USDT-SWAP');
  expect(parseInstrumentKey('coin:BTC-USDT-SWAP').kind).toBe('swap');
  expect(parseInstrumentKey('coin:ETH-USDT').kind).toBe('spot');
  expect(parseInstrumentKey('us:NYS:KO')).toMatchObject({ market: 'us', exchange: 'NYS', symbol: 'KO', kind: 'stock' });
  expect(() => parseInstrumentKey('xx:1')).toThrow();
  expect(() => parseInstrumentKey('us:XXX:AAPL')).toThrow();
  expect(() => parseInstrumentKey('kr:')).toThrow();
});

test('horizon bars', () => {
  expect(HORIZON_BARS.scalp).toEqual({ primary: '5m', primaryLimit: 288, secondary: '1H', secondaryLimit: 48 });
  expect(HORIZON_BARS.swing).toEqual({ primary: '4H', primaryLimit: 180, secondary: '1D', secondaryLimit: 120 });
  expect(HORIZON_BARS.long).toEqual({ primary: '1D', primaryLimit: 365, secondary: '1W', secondaryLimit: 104 });
});

test('stocks use daily bars for swing because KIS minute history is same-day only', async () => {
  const { horizonBars } = await import('../../src/market/types.js');
  expect(horizonBars('coin', 'swing')).toEqual(HORIZON_BARS.swing);
  expect(horizonBars('kr', 'swing')).toEqual({ primary: '1D', primaryLimit: 120, secondary: '1W', secondaryLimit: 52 });
  expect(horizonBars('us', 'scalp')).toEqual({ primary: '5m', primaryLimit: 78, secondary: '1D', secondaryLimit: 20 });
  expect(horizonBars('kr', 'long')).toEqual(HORIZON_BARS.long);
});
