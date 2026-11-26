import { expect, test } from 'vitest';
import { allocation, hueOf, marketStatus, yearStats } from '../src/insights';

test('Korean market is open on a weekday morning and says how long until close', () => {
  // 2026-11-26(목) 10:00 KST
  expect(marketStatus('kr', new Date('2026-11-26T01:00:00Z'))).toEqual({ open: true, text: '마감까지 5시간 30분' });
});

test('Korean market after the close counts down to the next morning', () => {
  // 목 16:00 KST → 금 09:00
  expect(marketStatus('kr', new Date('2026-11-26T07:00:00Z'))).toEqual({ open: false, text: '개장까지 17시간' });
});

test('Korean market on Saturday counts down to Monday', () => {
  // 토 12:00 KST → 월 09:00 = 45시간
  expect(marketStatus('kr', new Date('2026-11-28T03:00:00Z'))).toEqual({ open: false, text: '개장까지 1일 21시간' });
});

test('US market uses New York time in winter', () => {
  // 2026-11-25(수) 10:00 EST
  expect(marketStatus('us', new Date('2026-11-25T15:00:00Z'))).toEqual({ open: true, text: '마감까지 6시간' });
});

test('US market uses New York daylight saving time in summer', () => {
  // 2026-07-01(수) 09:00 EDT, 30분 뒤 개장
  expect(marketStatus('us', new Date('2026-07-01T13:00:00Z'))).toEqual({ open: false, text: '개장까지 30분' });
});

test('allocation keeps the largest slices and groups the rest', () => {
  const rows = [
    { key: 'a', label: 'A', value: 50 }, { key: 'b', label: 'B', value: 30 }, { key: 'c', label: 'C', value: 10 },
    { key: 'd', label: 'D', value: 6 }, { key: 'e', label: 'E', value: 4 }, { key: 'z', label: 'Z', value: 0 },
  ];
  const s = allocation(rows, 3);
  expect(s.map((x) => x.label)).toEqual(['A', 'B', 'C', '기타']);
  expect(s.map((x) => Math.round(x.pct))).toEqual([50, 30, 10, 10]);
});

test('allocation of nothing is empty', () => {
  expect(allocation([{ key: 'a', label: 'A', value: 0 }])).toEqual([]);
});

test('yearStats finds the one-year range and where the price sits in it', () => {
  const day = 86400;
  const now = 400 * day;
  const candles = Array.from({ length: 400 }, (_, i) => ({ time: i * day, open: 100, high: 100 + (i % 50), low: 90, close: 100, volume: 10 }));
  candles[10] = { ...candles[10]!, high: 999 }; // 1년보다 오래된 고점은 빼야 한다
  const s = yearStats(candles, 120, now)!;
  expect(s.high).toBe(149);
  expect(s.low).toBe(90);
  expect(s.position).toBeCloseTo((120 - 90) / (149 - 90));
  expect(s.fromHighPct).toBeCloseTo(((120 - 149) / 149) * 100);
  expect(s.avgVolume30).toBe(10);
});

test('yearStats needs some candles', () => {
  expect(yearStats([], 1, 0)).toBeNull();
});

test('hueOf is stable and within the color wheel', () => {
  expect(hueOf('BTC')).toBe(hueOf('BTC'));
  expect(hueOf('BTC')).toBeGreaterThanOrEqual(0);
  expect(hueOf('BTC')).toBeLessThan(360);
});
