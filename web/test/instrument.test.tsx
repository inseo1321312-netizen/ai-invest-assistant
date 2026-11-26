import { afterEach, expect, test, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockServer, quote } from './fakeServer';

vi.mock('lightweight-charts', () => ({
  CandlestickSeries: 'c', HistogramSeries: 'h', LineSeries: 'l',
  createSeriesMarkers: () => ({ setMarkers: () => {} }),
  createChart: () => ({
    addSeries: () => ({ setData: () => {}, applyOptions: () => {} }),
    subscribeClick: () => {}, unsubscribeClick: () => {},
    timeScale: () => ({ fitContent: () => {}, setVisibleRange: () => {} }),
    priceScale: () => ({ applyOptions: () => {} }),
    remove: () => {},
  }),
}));

import { InstrumentView } from '../src/components/InstrumentView';

afterEach(() => vi.unstubAllGlobals());

const news = [
  { title: '삼성전자 신제품 공개', url: 'https://news.example/1', source: '한국경제', publishedAt: Math.floor(Date.now() / 1000) - 3600 },
  { title: '반도체 업황 회복 기대', url: 'https://news.example/2', source: '매일경제', publishedAt: Math.floor(Date.now() / 1000) - 7200 },
];

function server(key: string, over: Record<string, Parameters<typeof mockServer>[0][string]> = {}) {
  return mockServer({
    '/api/market/quote': () => ({ quote: quote(70500, 1.2, key.startsWith('kr') ? 'KRW' : 'USDT'), name: key.startsWith('kr') ? '삼성전자' : '비트코인' }),
    '/api/market/candles': () => ({ candles: [] }),
    '/api/analysis/latest': () => ({ analyses: [] }),
    '/api/analysis/history': () => ({ items: [] }),
    '/api/news': () => ({ items: news }),
    '/api/watchlist': () => ({ keys: [] }),
    '/api/alerts': () => ({ coins: [], settings: { m5: 2, m15: 3, h1: 5, events: true } }),
    'POST /api/recent': () => ({ ok: true }),
    'POST /api/watchlist': () => ({ ok: true }),
    'POST /api/alerts/coins': () => ({ ok: true }),
    '/api/instrument/info': () => (key.startsWith('kr')
      ? { stock: { marketCap: 4.3e14, per: 12.5, pbr: 1.3, eps: 5000, high52: 88000, low52: 50000, currency: 'KRW' }, coin: null }
      : { stock: null, coin: { fundingRate: 0.0001, openInterestUsd: 1.9e9, longShortRatio: 2.37, liq1h: { longUsd: 1250, shortUsd: 500 }, kimchiPct: 0.97, upbitWarning: false, upbitCautions: [] } }),
    ...over,
  });
}

test('opening records a recent view and shows the name, news near the top, and fundamentals', async () => {
  const s = server('kr:005930');
  render(<InstrumentView keyId="kr:005930" onClose={() => {}} onChat={() => {}} />);
  expect(await screen.findByRole('heading', { name: /삼성전자/ })).toBeTruthy();
  await waitFor(() => expect(s.calls.find((c) => c.method === 'POST' && c.url.pathname === '/api/recent')?.body).toEqual({ key: 'kr:005930' }));
  const strip = await screen.findByRole('region', { name: '관련 뉴스' });
  expect(within(strip).getAllByRole('link')).toHaveLength(2);
  expect(within(strip).getByText('삼성전자 신제품 공개')).toBeTruthy();
  const info = await screen.findByRole('region', { name: '기본 정보' });
  expect(info.textContent).toContain('PER');
  expect(info.textContent).toContain('12.5');
  expect(info.textContent).toContain('430조');
  expect(screen.queryByRole('button', { name: '알림 코인' })).toBeNull();
});

test('star adds to favorites; coins have an alert bell and futures numbers', async () => {
  const s = server('coin:BTC-USDT');
  render(<InstrumentView keyId="coin:BTC-USDT" onClose={() => {}} onChat={() => {}} />);
  const star = await screen.findByRole('button', { name: '즐겨찾기' });
  expect(star.getAttribute('aria-pressed')).toBe('false');
  await userEvent.click(star);
  await waitFor(() => expect(s.calls.find((c) => c.method === 'POST' && c.url.pathname === '/api/watchlist')?.body).toEqual({ key: 'coin:BTC-USDT' }));
  expect(star.getAttribute('aria-pressed')).toBe('true');
  const bell = screen.getByRole('button', { name: '알림 코인' });
  await userEvent.click(bell);
  await waitFor(() => expect(s.calls.find((c) => c.method === 'POST' && c.url.pathname === '/api/alerts/coins')?.body).toEqual({ key: 'coin:BTC-USDT' }));
  const info = await screen.findByRole('region', { name: '선물 지표' });
  expect(info.textContent).toContain('펀딩비');
  expect(info.textContent).toContain('김치 프리미엄');
  expect(info.textContent).toContain('+0.97%');
});

test('already-favorite instruments show a pressed star', async () => {
  server('coin:BTC-USDT', { '/api/watchlist': () => ({ keys: ['coin:BTC-USDT'] }), '/api/alerts': () => ({ coins: ['coin:BTC-USDT'], settings: { m5: 2, m15: 3, h1: 5, events: true } }) });
  render(<InstrumentView keyId="coin:BTC-USDT" onClose={() => {}} onChat={() => {}} />);
  await waitFor(() => expect(screen.getByRole('button', { name: '즐겨찾기' }).getAttribute('aria-pressed')).toBe('true'));
  expect(screen.getByRole('button', { name: '알림 코인' }).getAttribute('aria-pressed')).toBe('true');
});
