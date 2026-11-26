import { expect, test } from 'vitest';
import { bigMoves } from '../src/bigMoves';

const candles = (closes: number[]) => closes.map((c, i) => ({ time: i, open: c, high: c, low: c, close: c, volume: 1 }));

test('marks the biggest rises and falls by close-to-close change, oldest first', () => {
  // +8%, +0.19%, +4.99%, -7.04%, 그 뒤로는 작은 움직임
  const m = bigMoves(candles([100, 108, 108.2, 113.6, 105.6, 105.8, 106, 105.9, 106.1, 106.0]), 3);
  expect(m.map((x) => x.time)).toEqual([1, 3, 4]);
  expect(m[0]!.pct).toBeCloseTo(8);
  expect(m[2]!.pct).toBeCloseTo(-7.04, 1);
});

test('keeps at most n each way and ignores moves under 0.5%', () => {
  const m = bigMoves(candles([100, 110, 121, 133.1, 146.4, 146.5]), 2);
  expect(m).toHaveLength(2);
  expect(m.every((x) => x.pct > 9)).toBe(true);
  expect(bigMoves(candles([100, 100.2, 100.1]), 3)).toEqual([]);
});
