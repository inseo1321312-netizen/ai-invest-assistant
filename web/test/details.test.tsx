import { afterEach, expect, test, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../src/App';
import { AlertSettings } from '../src/components/AlertSettings';
import { MarketOverview } from '../src/components/MarketOverview';
import { mockServer, overview } from './fakeServer';

afterEach(() => vi.unstubAllGlobals());

const ov = { items: [{ id: 'kospi', label: '코스피', value: 4711.21, changePct: 0.29, note: null }] };

function loggedIn() {
  return mockServer({
    '/api/me': () => ({ loggedIn: true }),
    '/api/feed': () => ({ items: [] }),
    '/api/market-overview': () => ov,
    '/api/market/coin/overview': () => overview(),
    '/api/market/kr/overview': () => overview(),
    '/api/market/us/overview': () => overview(),
  });
}

const overviewCalls = (s: ReturnType<typeof mockServer>) => s.calls.filter((c) => c.url.pathname === '/api/market-overview').length;

function pull(dy: number) {
  fireEvent.touchStart(window, { touches: [{ clientX: 100, clientY: 100 }] });
  fireEvent.touchMove(window, { touches: [{ clientX: 100, clientY: 100 + dy }] });
  fireEvent.touchEnd(window, { touches: [] });
}

test('pulling home down from the top reloads it; a short pull does not', async () => {
  const s = loggedIn();
  render(<App />);
  await screen.findByText('코스피');
  const before = overviewCalls(s);
  pull(30);
  await new Promise((r) => setTimeout(r, 30));
  expect(overviewCalls(s)).toBe(before);
  pull(220);
  await waitFor(() => expect(overviewCalls(s)).toBe(before + 1));
});

test('going offline shows a notice; coming back says so and reloads', async () => {
  const s = loggedIn();
  render(<App />);
  await screen.findByText('코스피');
  const before = overviewCalls(s);
  act(() => { window.dispatchEvent(new Event('offline')); });
  expect(await screen.findByText(/인터넷 연결이 끊겼어요/)).toBeTruthy();
  act(() => { window.dispatchEvent(new Event('online')); });
  expect(await screen.findByText('다시 연결됐어요')).toBeTruthy();
  await waitFor(() => expect(overviewCalls(s)).toBe(before + 1));
});

test('tapping 홈 again while on home scrolls back to the top', async () => {
  loggedIn();
  const scrollTo = vi.fn();
  vi.stubGlobal('scrollTo', scrollTo);
  vi.stubGlobal('matchMedia', () => ({ matches: false })); // 움직임 줄이기 꺼짐
  render(<App />);
  await screen.findByText('코스피');
  await userEvent.click(screen.getByRole('button', { name: '홈' }));
  expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
});

test('the market overview says what time it is as of', async () => {
  mockServer({ '/api/market-overview': () => ov });
  render(<MarketOverview />);
  expect(await screen.findByText(/^\d{2}:\d{2} 기준$/)).toBeTruthy();
});

test('alert coins show their logo', async () => {
  mockServer({ '/api/alerts': () => ({ coins: ['coin:BTC-USDT-SWAP'], settings: { m5: 3, m15: 5, h1: 8, events: true } }) });
  const { container } = render(<AlertSettings />);
  await screen.findByText('BTC 무기한');
  expect(container.querySelector('.chip img')?.getAttribute('src')).toBe('/api/logo?key=coin%3ABTC-USDT-SWAP');
});

test('index lights follow the server (a US holiday stays dark even during US hours)', async () => {
  mockServer({ '/api/market-overview': () => ({ items: [
    { id: 'kospi', label: '코스피', value: 4711.21, changePct: 0.29, note: null, open: true },
    { id: 'spx', label: 'S&P500', value: 7182.78, changePct: -0.25, note: null, open: false },
  ] }) });
  render(<MarketOverview />);
  const kospi = await screen.findByRole('group', { name: '코스피' });
  expect(kospi.querySelector('.ov-led')?.classList.contains('open')).toBe(true);
  expect(screen.getByRole('group', { name: 'S&P500' }).querySelector('.ov-led')?.classList.contains('open')).toBe(false);
});
