import { afterEach, expect, test, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../src/App';
import { mockServer } from './fakeServer';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const today = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
const SETTINGS = { sleep: '23:00', wake: '07:00', notify: true };
const recap = (day: string, id = 5) => ({
  id, day, from: Date.now() - 9 * 3600_000, to: Date.now() - 3600_000, origin: 'scheduled', provider: 'claude', model: 'm', createdAt: Date.now(), costUsd: 0,
  headline: '나스닥 +1.2% 마감', points: ['하나', '둘', '셋'], items: [], news: [], today: [],
  facts: { market: { spx: null, nasdaq: null, btc: null, usdkrw: null, kimchi: null }, items: [], news: [] },
});

function server(view: () => Record<string, unknown>) {
  return mockServer({
    '/api/me': () => ({ loggedIn: true }),
    '/api/overnight': () => ({ recap: null, settings: SETTINGS, making: false, error: null, sleepTimes: [], wakeTimes: [], ...view() }),
    '/api/overnight/history': () => ({ items: [] }),
  });
}

test('the first open after today’s recap is made: it slides up by itself, once', async () => {
  server(() => ({ recap: recap(today()) }));
  const first = render(<App />);
  const sheet = await screen.findByRole('dialog', { name: '밤사이' });
  expect(await within(sheet).findByText('나스닥 +1.2% 마감')).toBeTruthy();
  await userEvent.click(within(sheet).getByRole('button', { name: '닫기' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '밤사이' })).toBeNull());
  first.unmount();
  render(<App />);
  await screen.findByRole('navigation', { name: '메뉴' });
  await new Promise((r) => setTimeout(r, 50));
  expect(screen.queryByRole('dialog', { name: '밤사이' })).toBeNull();
});

test('yesterday’s recap (before today’s wake time) does not pop up', async () => {
  const yesterday = new Date(Date.now() + 9 * 3600_000 - 86400_000).toISOString().slice(0, 10);
  server(() => ({ recap: recap(yesterday) }));
  render(<App />);
  await screen.findByRole('navigation', { name: '메뉴' });
  await new Promise((r) => setTimeout(r, 50));
  expect(screen.queryByRole('dialog', { name: '밤사이' })).toBeNull();
});

test('while it is being made, it pops up when done', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  let done = false;
  server(() => (done ? { recap: recap(today(), 9) } : { making: true }));
  render(<App />);
  await screen.findByRole('navigation', { name: '메뉴' });
  expect(screen.queryByRole('dialog', { name: '밤사이' })).toBeNull();
  done = true;
  await act(async () => { await vi.advanceTimersByTimeAsync(8100); });
  expect(await screen.findByRole('dialog', { name: '밤사이' })).toBeTruthy();
});

test('the moon on home opens it any time', async () => {
  localStorage.setItem('overnight.seen', '5');
  server(() => ({ recap: recap(today()) }));
  render(<App />);
  await userEvent.click(await screen.findByRole('button', { name: '밤사이 보기' }));
  expect(await screen.findByRole('dialog', { name: '밤사이' })).toBeTruthy();
});

test('tapping the push while the app is open shows it', async () => {
  localStorage.setItem('overnight.seen', '5');
  const sw = Object.assign(new EventTarget(), { controller: null, getRegistration: async () => undefined });
  Object.defineProperty(navigator, 'serviceWorker', { value: sw, configurable: true });
  server(() => ({ recap: recap(today()) }));
  render(<App />);
  await screen.findByRole('navigation', { name: '메뉴' });
  sw.dispatchEvent(new MessageEvent('message', { data: { type: 'open', url: '/?tab=overnight' } }));
  expect(await screen.findByRole('dialog', { name: '밤사이' })).toBeTruthy();
  delete (navigator as { serviceWorker?: unknown }).serviceWorker;
});
