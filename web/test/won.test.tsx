import { afterEach, expect, test } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { formatPrice, setPriceUnit, setUsdKrw } from '../src/format';
import { readPrefs } from '../src/prefs';
import { DisplaySettings } from '../src/components/MoreSettings';

afterEach(() => { setPriceUnit('native'); setUsdKrw(null); });

test('in won mode dollar and USDT prices are shown in won using the exchange rate', () => {
  setUsdKrw(1345);
  setPriceUnit('krw');
  expect(formatPrice(355.58, 'USD')).toBe('478,255원');
  expect(formatPrice(0.006358, 'USDT')).toBe('8.55원');
  expect(formatPrice(171500, 'KRW')).toBe('171,500원');
});

test('without a rate yet, prices stay in their own unit', () => {
  setPriceUnit('krw');
  expect(formatPrice(355.58, 'USD')).toBe('$355.58');
});

test('settings has a price unit choice that is remembered', async () => {
  render(<DisplaySettings />);
  expect(readPrefs().unit).toBe('native');
  await userEvent.click(screen.getByRole('radio', { name: '원화' }));
  expect(readPrefs().unit).toBe('krw');
  setUsdKrw(1300);
  expect(formatPrice(10, 'USD')).toBe('13,000원');
});

test('the app picks up the exchange rate when it opens, so favorites show in won', async () => {
  const { mockServer, overview, quote } = await import('./fakeServer');
  const App = (await import('../src/App')).default;
  const { vi } = await import('vitest');
  localStorage.setItem('prefs', JSON.stringify({ theme: 'system', updown: 'kr', unit: 'krw' }));
  const { applyPrefs } = await import('../src/prefs');
  applyPrefs(readPrefs());
  const btc = { key: 'coin:BTC-USDT', instrument: { market: 'coin', symbol: 'BTC-USDT', kind: 'spot', exchange: null, name: '비트코인' }, quote: quote(100, 1), krwValue: null, badge: null };
  mockServer({
    '/api/me': () => ({ loggedIn: true }),
    '/api/feed': () => ({ items: [] }),
    '/api/market-overview': () => ({ items: [{ id: 'usdkrw', label: '원/달러', value: 1345, changePct: null, note: null, open: null }] }),
    '/api/market/coin/overview': () => overview({ favorites: [btc] }),
    '/api/market/kr/overview': () => overview(),
    '/api/market/us/overview': () => overview(),
  });
  render(<App />);
  expect(await screen.findByText('134,500원', {}, { timeout: 2000 })).toBeTruthy();
  vi.unstubAllGlobals();
});
