import { afterEach, describe, expect, test, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../src/App';
import { mockServer, overview, quote } from './fakeServer';

afterEach(() => vi.unstubAllGlobals());

const swapRow = {
  key: 'coin:BTC-USDT-SWAP', instrument: { market: 'coin', symbol: 'BTC-USDT-SWAP', kind: 'swap', exchange: null, name: null },
  quantity: 0.03, avgPrice: 97000, currency: 'USDT', source: 'okx', side: 'long', leverage: 10, liqPrice: 88900, markPrice: 96420,
  unrealizedPnl: -128, fundingRate: 0.0001, quote: quote(96420, -3.8), krwValue: 4049640, pnlPct: -0.6,
  badge: { opinion: '유지', confidence: '중간', dataTime: Date.UTC(2026, 10, 26, 0, 0) / 1000, provider: 'claude' },
};

const feed = { items: [
  { id: 1, createdAt: 1, day: '2026-11-26', kind: 'briefing', market: 'coin', key: null, title: '코인 아침 브리핑', body: '요약', isBreaking: false },
  { id: 2, createdAt: 2, day: '2026-11-26', kind: 'breaking', market: 'coin', key: 'coin:BTC-USDT', title: '비트코인 4% 급락', body: 'ETF 자금 유출', isBreaking: true },
] };

function loggedIn(over: Record<string, unknown> = {}) {
  return mockServer({
    '/api/me': () => ({ loggedIn: true }),
    '/api/feed': () => ({ items: [feed.items[1], feed.items[0]] }),
    '/api/market/coin/overview': () => overview({ holdings: [swapRow] }),
    '/api/market/kr/overview': () => overview(),
    '/api/market/us/overview': () => overview(),
    ...over,
  });
}

describe('app shell', () => {
  test('shows login when /api/me says logged out, then logs in', async () => {
    let logged = false;
    mockServer({
      '/api/me': () => ({ loggedIn: logged }),
      'POST /api/login': () => { logged = true; return { ok: true }; },
      '/api/feed': () => ({ items: [] }),
      '/api/market/coin/overview': () => overview(),
    });
    render(<App />);
    const input = await screen.findByLabelText('비밀번호');
    await userEvent.type(input, 'secret-password');
    await userEvent.click(screen.getByRole('button', { name: '로그인' }));
    expect(await screen.findByRole('tab', { name: '코인' })).toBeTruthy();
  });

  test('wrong password shows server message', async () => {
    mockServer({
      '/api/me': () => ({ loggedIn: false }),
      'POST /api/login': () => new Response(JSON.stringify({ error: '비밀번호가 틀렸습니다' }), { status: 401 }),
    });
    render(<App />);
    await userEvent.type(await screen.findByLabelText('비밀번호'), 'nope');
    await userEvent.click(screen.getByRole('button', { name: '로그인' }));
    expect(await screen.findByText('비밀번호가 틀렸습니다')).toBeTruthy();
  });

  test('breaking feed item shows [속보] first', async () => {
    loggedIn();
    render(<App />);
    const banner = await screen.findByRole('region', { name: '오늘의 소식' });
    const items = await within(banner).findAllByRole('listitem');
    expect(items[0]!.textContent).toContain('[속보]');
    expect(items[0]!.textContent).toContain('비트코인 4% 급락');
    expect(items[1]!.textContent).not.toContain('[속보]');
  });

  test('futures row shows leverage, liq price distance, badge with horizon and time', async () => {
    loggedIn();
    render(<App />);
    const row = await screen.findByRole('button', { name: /BTC-USDT-SWAP/ });
    const t = row.textContent!;
    expect(t).toContain('롱 10x');
    expect(t).toContain('96,420 USDT');
    expect(t).toContain('-3.8%');
    expect(t).toContain('청산가 88,900');
    expect(t).toContain('7.8%');
    expect(t).toContain('유지');
    expect(t).toContain('스윙 11-26 09:00');
    expect(t).toContain('≈ 405만원');
    expect(screen.getByText('선물 포지션')).toBeTruthy();
  });

  test('switching tab loads that market and remembers it', async () => {
    const s = loggedIn();
    render(<App />);
    await userEvent.click(await screen.findByRole('tab', { name: '한국주식' }));
    expect(await screen.findByText(/보유 종목이 없어요/)).toBeTruthy();
    expect(s.calls.some((c) => c.url.pathname === '/api/market/kr/overview')).toBe(true);
    expect(localStorage.getItem('tab')).toBe('kr');
  });

  test('source errors and not-connected notice are shown', async () => {
    loggedIn({ '/api/market/coin/overview': () => overview({ connected: false, errors: ['OKX 데이터를 가져오지 못했습니다'] }) });
    render(<App />);
    expect(await screen.findByText('OKX 데이터를 가져오지 못했습니다')).toBeTruthy();
    expect(screen.getByText(/OKX 계정이 연결되지 않았어요/)).toBeTruthy();
  });

  test('adding a watchlist symbol posts its key', async () => {
    const s = loggedIn({ 'POST /api/watchlist': () => ({ ok: true }) });
    render(<App />);
    await userEvent.type(await screen.findByLabelText('관심 종목 추가'), 'sol');
    await userEvent.click(screen.getByRole('button', { name: '추가' }));
    expect(s.calls.find((c) => c.method === 'POST' && c.url.pathname === '/api/watchlist')?.body).toEqual({ key: 'coin:SOL-USDT' });
  });

  test('disclaimer always visible', async () => {
    loggedIn();
    render(<App />);
    expect(await screen.findByText('투자 판단과 책임은 본인에게 있음')).toBeTruthy();
  });
});
