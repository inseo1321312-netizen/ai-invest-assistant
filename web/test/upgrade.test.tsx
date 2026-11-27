import { afterEach, describe, expect, test, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockServer, overview, sseResponse } from './fakeServer';

vi.mock('lightweight-charts', () => {
  const series = () => ({ setData: () => {}, applyOptions: () => {} });
  return {
    CandlestickSeries: 'c', HistogramSeries: 'h', LineSeries: 'l', createSeriesMarkers: () => ({}),
    createChart: () => ({
      addSeries: series, subscribeClick: () => {}, unsubscribeClick: () => {},
      timeScale: () => ({ fitContent: () => {}, setVisibleRange: () => {} }), priceScale: () => ({ applyOptions: () => {} }), remove: () => {},
    }),
  };
});

import App from '../src/App';
import { ChatView } from '../src/components/ChatView';
import { InstrumentView } from '../src/components/InstrumentView';

afterEach(() => vi.unstubAllGlobals());

const MODELS = {
  lists: {
    claude: [{ id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' }, { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' }],
    gpt: [{ id: 'gpt-6-luna', label: 'GPT-6 Luna' }, { id: 'gpt-6.2-sol', label: 'GPT-6.2 Sol' }],
  },
  defaults: { claude: { light: 'claude-haiku-5-5', standard: 'claude-sonnet-5-5', deep: 'claude-opus-5-5' }, gpt: { light: 'gpt-6-luna', standard: 'gpt-6-luna', deep: 'gpt-6.2-sol' } },
};
const USAGE = { today: { interactive: 0.42, scheduled: 0.1 }, month: 3.2, gptMonth: 0, limits: { interactiveDailyUsd: 3, scheduledDailyUsd: 1.5, monthlyUsd: 80 }, requests: { gpt5h: 12, gptToday: 20, claudeToday: 4 }, gptLimitHitAt: null };
const answer = (text: string) => sseResponse([{ type: 'chat', chatId: 9 }, { type: 'text', delta: text }, { type: 'done', text, provider: 'gpt', model: 'gpt-6.2-sol', costUsd: 0 }]);

describe('chat upgrade', () => {
  test('model picker lists ChatGPT models and sends the chosen model', async () => {
    const s = mockServer({ '/api/ai/models': () => MODELS, '/api/usage': () => USAGE, '/api/chats': () => ({ chats: [] }), 'POST /api/chat': () => answer('답') });
    render(<ChatView keyId={null} />);
    await userEvent.click(await screen.findByRole('button', { name: 'AI 모델 선택' }));
    const sheet = await screen.findByRole('dialog', { name: '모델 선택' });
    await userEvent.click(within(sheet).getByRole('tab', { name: 'GPT' }));
    await userEvent.click(within(sheet).getByRole('radio', { name: /GPT-6.2 Sol/ }));
    expect(screen.getByRole('button', { name: 'AI 모델 선택' }).textContent).toContain('GPT-6.2 Sol');
    await userEvent.type(screen.getByLabelText('메시지'), '안녕');
    await userEvent.click(screen.getByRole('button', { name: '보내기' }));
    await waitFor(() => expect(s.calls.find((c) => c.method === 'POST' && c.url.pathname === '/api/chat')?.body).toMatchObject({ provider: 'gpt', model: 'gpt-6.2-sol' }));
    expect(await screen.findByText('답')).toBeTruthy();
  });

  test('usage pill shows Claude spend, ChatGPT request count, and details sheet', async () => {
    mockServer({ '/api/ai/models': () => MODELS, '/api/usage': () => USAGE, '/api/chats': () => ({ chats: [] }) });
    render(<ChatView keyId={null} />);
    expect(await screen.findByText('오늘 $0.42')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '사용량' }));
    const sheet = await screen.findByRole('dialog', { name: '사용량' });
    expect(within(sheet).getByText('12회')).toBeTruthy();
    expect(within(sheet).getByRole('link', { name: 'ChatGPT 사용량 열기' }).getAttribute('href')).toBe('https://chatgpt.com/settings/usage');
  });

  test('reopens the recent conversation for the same symbol and continues it', async () => {
    const s = mockServer({
      '/api/ai/models': () => MODELS, '/api/usage': () => USAGE,
      '/api/chats': () => ({ chats: [{ id: 5, key: 'coin:BTC-USDT', title: '살까?', createdAt: Date.now() - 60_000 }] }),
      '/api/chats/5/messages': () => ({ messages: [{ id: 1, role: 'user', text: '살까?', provider: null }, { id: 2, role: 'assistant', text: '기다려 보세요', provider: 'claude' }] }),
      'POST /api/chat': () => answer('네'),
    });
    render(<ChatView keyId="coin:BTC-USDT" onClose={() => {}} />);
    expect(await screen.findByText('기다려 보세요')).toBeTruthy();
    await userEvent.type(screen.getByLabelText('메시지'), '그럼?');
    await userEvent.click(screen.getByRole('button', { name: '보내기' }));
    await waitFor(() => expect(s.calls.find((c) => c.method === 'POST' && c.url.pathname === '/api/chat')?.body).toMatchObject({ chatId: 5, key: 'coin:BTC-USDT' }));
  });
});

describe('instrument upgrade', () => {
  test('choosing 단타 switches the chart to 5-minute candles; indicator toggles', async () => {
    const s = mockServer({ '/api/market/candles': () => ({ candles: [] }), '/api/analysis/latest': () => ({ analyses: [] }), '/api/market/quote': () => ({ quote: { price: 100, changePct24h: 1, currency: 'USDT', time: 0 } }) });
    render(<InstrumentView keyId="coin:BTC-USDT" onClose={() => {}} onChat={() => {}} />);
    await userEvent.click(await screen.findByRole('radio', { name: '단타' }));
    await waitFor(() => expect(s.calls.some((c) => c.url.pathname === '/api/market/candles' && c.url.searchParams.get('bar') === '5m')).toBe(true));
    const rsi = screen.getByRole('button', { name: 'RSI' });
    expect(rsi.getAttribute('aria-pressed')).toBe('false');
    await userEvent.click(rsi);
    expect(rsi.getAttribute('aria-pressed')).toBe('true');
    expect(await screen.findByText('100 USDT')).toBeTruthy();
  });
});

describe('shell', () => {
  test('bottom nav switches to chat', async () => {
    mockServer({
      '/api/me': () => ({ loggedIn: true }),
      '/api/market/coin/overview': () => overview(),
      '/api/ai/models': () => MODELS, '/api/usage': () => USAGE, '/api/chats': () => ({ chats: [] }),
    });
    localStorage.setItem('tab', 'coin');
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: /AI 상담/ }));
    expect(await screen.findByRole('region', { name: 'AI 채팅' })).toBeTruthy();
  });
});
