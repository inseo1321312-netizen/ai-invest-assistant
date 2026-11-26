import { afterEach, describe, expect, test, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../src/App';
import { mockServer, overview, quote } from './fakeServer';

afterEach(() => vi.unstubAllGlobals());

const favRow = {
  key: 'coin:BTC-USDT', instrument: { market: 'coin', symbol: 'BTC-USDT', kind: 'spot', exchange: null, name: '비트코인' },
  quote: quote(96420, -3.8), krwValue: 134988000,
  badge: { opinion: '관망', confidence: '중간', dataTime: Date.UTC(2026, 10, 26, 0, 0) / 1000, provider: 'claude' },
};

const feed = { items: [
  { id: 1, createdAt: 1, day: '2026-11-26', kind: 'briefing', market: 'coin', key: null, title: '코인 아침 브리핑', body: '요약', isBreaking: false },
  { id: 2, createdAt: 2, day: '2026-11-26', kind: 'breaking', market: 'coin', key: 'coin:BTC-USDT', title: '비트코인 4% 급락', body: 'ETF 자금 유출', isBreaking: true },
] };

function loggedIn(over: Record<string, unknown> = {}) {
  return mockServer({
    '/api/me': () => ({ loggedIn: true }),
    '/api/feed': () => ({ items: [feed.items[1], feed.items[0]] }),
    '/api/market/coin/overview': () => overview({ favorites: [favRow] }),
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

  test('favorite row shows the Korean name, price, change and AI badge', async () => {
    loggedIn();
    render(<App />);
    const row = await screen.findByRole('button', { name: /BTC-USDT/ });
    const t = row.textContent!;
    expect(t).toContain('비트코인');
    expect(t).toContain('96,420 USDT');
    expect(t).toContain('-3.8%');
    expect(t).toContain('관망');
    expect(t).toContain('스윙 11-26 09:00');
  });

  test('home has search, the market overview and trending', async () => {
    loggedIn({ '/api/market-overview': () => ({ items: [{ id: 'kospi', label: '코스피', value: 2650, changePct: 0.4, note: null }] }), '/api/trending/coin': () => ({ items: [] }) });
    render(<App />);
    expect(await screen.findByRole('button', { name: '종목 검색' })).toBeTruthy();
    expect(await screen.findByRole('region', { name: '오늘 시장 한눈에' })).toBeTruthy();
    expect(await screen.findByRole('region', { name: '지금 뜨는' })).toBeTruthy();
  });

  test('switching tab loads that market and remembers it', async () => {
    const s = loggedIn();
    render(<App />);
    await userEvent.click(await screen.findByRole('tab', { name: '한국주식' }));
    expect(await screen.findByText(/검색해서 ★을 누르면 여기에 모여요/)).toBeTruthy();
    expect(s.calls.some((c) => c.url.pathname === '/api/market/kr/overview')).toBe(true);
    expect(localStorage.getItem('tab')).toBe('kr');
  });

  test('source errors are shown', async () => {
    loggedIn({ '/api/market/coin/overview': () => overview({ errors: ['OKX 데이터를 가져오지 못했습니다'] }) });
    render(<App />);
    expect(await screen.findByText('OKX 데이터를 가져오지 못했습니다')).toBeTruthy();
  });

  test('disclaimer always visible', async () => {
    loggedIn();
    render(<App />);
    expect(await screen.findByText('투자 판단과 책임은 본인에게 있음')).toBeTruthy();
  });
});
