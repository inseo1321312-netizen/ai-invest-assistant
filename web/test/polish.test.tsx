import { afterEach, expect, test } from 'vitest';
import { render } from '@testing-library/react';
import { axisPrice, rangeLabel, setPriceUnit, setUsdKrw } from '../src/format';
import { SessionLine } from '../src/components/SessionLine';

afterEach(() => { setPriceUnit('native'); setUsdKrw(null); });

test('chart price labels: won without decimals, commas everywhere, small coins keep their digits', () => {
  expect(axisPrice(178200, 'KRW')).toBe('178,200');
  expect(axisPrice(355.5, 'USD')).toBe('355.50');
  expect(axisPrice(61744.5, 'USDT')).toBe('61,744.5');
  expect(axisPrice(0.006358, 'USDT')).toBe('0.006358');
  setUsdKrw(1345);
  setPriceUnit('krw');
  expect(axisPrice(355.58, 'USD')).toBe('478,255');
});

test('range labels: days without a clock, years only when they differ, minutes with a clock', () => {
  const kst = (s: string) => Date.parse(`${s}+09:00`) / 1000;
  expect(rangeLabel(kst('2026-01-23T00:00:00'), kst('2026-10-13T00:00:00'), '1D')).toBe('01/23 ~ 10/13');
  expect(rangeLabel(kst('2025-12-30T00:00:00'), kst('2026-01-05T00:00:00'), '1D')).toBe('25/12/30 ~ 26/01/05');
  expect(rangeLabel(kst('2026-11-27T09:05:00'), kst('2026-11-27T10:30:00'), '5m')).toBe('11/27 09:05 ~ 11/27 10:30');
});

test('during after-hours the main line just says the market is closed', () => {
  const t = Date.parse('2026-11-27T16:37:00+09:00') / 1000;
  const { container } = render(<SessionLine session={{ open: false, tradedAt: t, extended: { kind: 'after', open: true, price: 178400, changePct: 0, tradedAt: t } }} currency="KRW" />);
  const text = container.textContent ?? '';
  expect(text).toContain('장 마감');
  expect(text).not.toContain('마지막 거래');
  expect(text).toContain('애프터마켓 거래 중');
});
