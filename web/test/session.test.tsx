import { expect, test } from 'vitest';
import { render } from '@testing-library/react';
import { SessionLine } from '../src/components/SessionLine';

const closeAt = Date.parse('2026-11-25T16:00:00-05:00') / 1000; // 한국 11/26 06:00

test('open regular market shows a live badge', () => {
  const { container } = render(<SessionLine session={{ open: true, tradedAt: null, extended: null }} currency="KRW" />);
  expect(container.textContent).toContain('정규장');
  expect(container.querySelector('.session-dot.live')).not.toBeNull();
});

test('closed market shows when it last traded (Korean time) and the after-market price from the close', () => {
  const { container } = render(
    <SessionLine
      session={{ open: false, tradedAt: closeAt, extended: { kind: 'after', open: false, price: 355.1, changePct: -0.135, tradedAt: closeAt + 4 * 3600 } }}
      currency="USD"
    />,
  );
  const text = container.textContent ?? '';
  expect(text).toContain('장 마감');
  expect(text).toContain('11/26 06:00');
  expect(text).toContain('애프터마켓');
  expect(text).toContain('$355.10');
  expect(text).toContain('-0.1%');
  expect(container.querySelector('.session-dot.live')).toBeNull();
});

test('a running pre-market is marked live', () => {
  const { container } = render(
    <SessionLine session={{ open: false, tradedAt: closeAt, extended: { kind: 'pre', open: true, price: 170000, changePct: -0.87, tradedAt: null } }} currency="KRW" />,
  );
  expect(container.textContent).toContain('프리마켓 거래 중');
  expect(container.querySelector('.session-ext .session-dot.live')).not.toBeNull();
});

test('before the open it says so instead of closed', () => {
  const { container } = render(<SessionLine session={{ open: false, beforeOpen: true, tradedAt: closeAt, extended: null }} currency="USD" />);
  expect(container.textContent).toContain('개장 전');
  expect(container.textContent).not.toContain('장 마감');
});
