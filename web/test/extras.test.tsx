import { afterEach, expect, test, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
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

