import { afterEach, expect, test, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { mockServer, overview, quote } from './fakeServer';

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
import { HoldingsList } from '../src/components/HoldingsList';

afterEach(() => vi.unstubAllGlobals());

const item = (id: number, provider: string, horizon: string, opinion: string) => ({ id, provider, horizon, opinion, confidence: '중간', dataTime: 1764115200, createdAt: 0, tier: 'standard', origin: 'user' });

test('instrument view lists how the AI opinion changed over time', async () => {
  mockServer({
    '/api/market/quote': () => ({ quote: quote(100, 1) }),
    '/api/market/candles': () => ({ candles: [] }),
    '/api/analysis/latest': () => ({ analyses: [] }),
    '/api/analysis/history': () => ({ items: [item(2, 'gpt', 'long', '추가 매수'), item(1, 'claude', 'swing', '일부 매도')] }),
  });
  render(<InstrumentView keyId="coin:BTC-USDT" onClose={() => {}} onChat={() => {}} />);
  const list = await screen.findByRole('list', { name: 'AI 의견 기록' });
  expect(within(list).getAllByRole('listitem')).toHaveLength(2);
  expect(within(list).getByText('추가 매수')).toBeTruthy();
  expect(within(list).getByText(/GPT 장기/)).toBeTruthy();
});

test('coin tab shows the fear and greed index', async () => {
  mockServer({
    '/api/market/coin/overview': () => overview(),
    '/api/market/sentiment': () => ({ sentiment: { value: 23, label: '극도의 공포', updatedAt: 0 } }),
  });
  render(<HoldingsList market="coin" onOpen={() => {}} />);
  const card = await screen.findByRole('region', { name: '공포·탐욕 지수' });
  expect(within(card).getByText('극도의 공포')).toBeTruthy();
  expect(within(card).getByText('23')).toBeTruthy();
});

test('stock tabs do not ask for the coin index', async () => {
  const s = mockServer({ '/api/market/kr/overview': () => overview() });
  render(<HoldingsList market="kr" onOpen={() => {}} />);
  await screen.findByText(/보유 종목이 없어요/);
  expect(s.calls.some((c) => c.url.pathname === '/api/market/sentiment')).toBe(false);
});
