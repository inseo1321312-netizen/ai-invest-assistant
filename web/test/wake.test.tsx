import { afterEach, expect, test, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockServer, overview } from './fakeServer';

vi.mock('lightweight-charts', () => ({ createChart: () => ({}), CandlestickSeries: 'c', HistogramSeries: 'h', LineSeries: 'l', createSeriesMarkers: () => ({}) }));

import App from '../src/App';
import { SettingsView } from '../src/components/SettingsView';

afterEach(() => vi.unstubAllGlobals());

test('shows a wake-up screen while the sleeping server starts, then the app', async () => {
  mockServer({
    '/api/me': async () => { await new Promise((r) => setTimeout(r, 1600)); return { loggedIn: false }; },
  });
  render(<App />);
  expect(await screen.findByText(/서버를 깨우는 중/, {}, { timeout: 1500 })).toBeTruthy();
  expect(await screen.findByLabelText('비밀번호', {}, { timeout: 3000 })).toBeTruthy();
});

test('fast server skips the wake-up screen', async () => {
  mockServer({ '/api/me': () => ({ loggedIn: false }) });
  render(<App />);
  expect(await screen.findByLabelText('비밀번호')).toBeTruthy();
  expect(screen.queryByText(/서버를 깨우는 중/)).toBeNull();
});

test('settings connection check lists each service with its state', async () => {
  mockServer({
    '/api/settings': () => ({ models: { claude: { light: 'a', standard: 'b', deep: 'c' }, gpt: { light: 'd', standard: 'e', deep: 'f' } }, gptMode: 'siwc', budget: { scheduledDailyUsd: 1, interactiveDailyUsd: 1, monthlyUsd: 1, gptMonthlyUsd: 1 }, keys: { claude: true, openai: false, okx: true, kis: true, push: true } }),
    '/api/usage': () => ({ today: { interactive: 0, scheduled: 0 }, month: 0, gptMonth: 0 }),
    '/api/admin/siwc-status': () => ({ connected: false, expiresAt: null }),
    '/api/market/coin/overview': () => overview(),
    '/api/admin/diagnose': () => ({ checks: [
      { id: 'okx', label: 'OKX 시세', state: 'ok', detail: '비트코인 60,000 USDT' },
      { id: 'kis', label: '한국투자증권', state: 'fail', detail: '앱키·앱시크릿·계좌번호를 확인하세요' },
      { id: 'storage', label: '데이터 저장', state: 'warn', detail: '바깥 저장소가 없어요' },
    ] }),
  });
  render(<SettingsView />);
  await userEvent.click(await screen.findByRole('button', { name: '연결 점검' }));
  const list = await screen.findByRole('list', { name: '연결 점검 결과' });
  expect(within(list).getByText('비트코인 60,000 USDT')).toBeTruthy();
  expect(within(list).getByText('앱키·앱시크릿·계좌번호를 확인하세요')).toBeTruthy();
  expect(within(list).getAllByRole('listitem')).toHaveLength(3);
});

test('retries while the server is still starting (503), keeping the wake-up screen', async () => {
  let n = 0;
  mockServer({ '/api/me': () => (++n < 2 ? new Response('waking', { status: 503 }) : { loggedIn: true }), '/api/feed': () => ({ items: [] }), '/api/market/coin/overview': () => overview() });
  render(<App />);
  expect(await screen.findByRole('tab', { name: '코인' }, { timeout: 5000 })).toBeTruthy();
  expect(n).toBe(2);
});
