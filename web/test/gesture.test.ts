import { expect, test, vi } from 'vitest';
import { createGesture, rangeOf } from '../src/chartGesture';

const candles = [100, 110, 99, 120, 130].map((close, i) => ({ time: 1000 + i * 60, open: close, high: close + 1, low: close - 1, close, volume: 1 }));

test('a dragged stretch knows its start, end and change from the close before it', () => {
  expect(rangeOf(candles, 3, 1)).toEqual({ from: 1060, to: 1180, pct: (120 / 100 - 1) * 100, count: 3 });
  expect(rangeOf(candles, 0, 1)).toMatchObject({ from: 1000, to: 1060, pct: (110 / 100 - 1) * 100 });
  expect(rangeOf(candles, -5, 99)).toMatchObject({ from: 1000, to: 1240, count: 5 });
});

test('one finger dragging picks a stretch; a tiny wobble does not', () => {
  const h = { onPreview: vi.fn(), onPick: vi.fn(), onPan: vi.fn() };
  const g = createGesture(h);
  g.down(1, 100);
  g.move(1, 104);
  g.up(1);
  expect(h.onPick).not.toHaveBeenCalled();
  g.down(1, 100);
  g.move(1, 160);
  expect(h.onPreview).toHaveBeenLastCalledWith({ x0: 100, x1: 160 });
  g.up(1);
  expect(h.onPick).toHaveBeenCalledWith(100, 160);
  expect(h.onPreview).toHaveBeenLastCalledWith(null);
});

test('two fingers cancel the pick and slide the chart instead (pinch zoom is the chart’s own)', () => {
  const h = { onPreview: vi.fn(), onPick: vi.fn(), onPan: vi.fn() };
  const g = createGesture(h);
  g.down(1, 100);
  g.move(1, 150);
  g.down(2, 200);
  g.move(1, 170);
  g.move(2, 220);
  g.up(1);
  g.up(2);
  expect(h.onPick).not.toHaveBeenCalled();
  expect(h.onPan).toHaveBeenCalled();
  const total = h.onPan.mock.calls.reduce((s, [dx]) => s + dx, 0);
  expect(total).toBeCloseTo(20, 6);
});
