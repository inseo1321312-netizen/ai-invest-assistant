import { afterEach, describe, expect, test, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockServer, sseResponse } from './fakeServer';

// lightweight-charts는 캔버스를 쓰므로 가짜로 바꾼다. 클릭 핸들러를 잡아 둔다.
const chartState = vi.hoisted(() => ({ click: null as null | ((p: { time?: number }) => void), data: [] as unknown[] }));
// data에는 캔들 시리즈 데이터만 기록한다
vi.mock('lightweight-charts', () => {
  const series = (type: string) => ({ setData: (d: unknown[]) => { if (type === 'candle') chartState.data = d; }, setMarkers: () => {}, applyOptions: () => {} });
  return {
    CandlestickSeries: 'candle', HistogramSeries: 'hist', LineSeries: 'line',
    createSeriesMarkers: () => ({ setMarkers: () => {} }),
    createChart: () => ({
      addSeries: series,
      subscribeClick: (fn: (p: { time?: number }) => void) => { chartState.click = fn; },
      unsubscribeClick: () => {},
      timeScale: () => ({ fitContent: () => {}, setVisibleRange: () => {}, coordinateToLogical: (x: number) => x / 100, scrollPosition: () => 0, scrollToPosition: () => {}, options: () => ({ barSpacing: 6 }) }),
      priceScale: () => ({ applyOptions: () => {} }),
      applyOptions: () => {},
      remove: () => {},
    }),
  };
});

import { CandleChart } from '../src/components/CandleChart';
import { InstrumentView } from '../src/components/InstrumentView';
import { ChatView } from '../src/components/ChatView';
import { SettingsView } from '../src/components/SettingsView';

afterEach(() => { vi.unstubAllGlobals(); chartState.click = null; });

const KST_OFFSET = 9 * 3600;
const candles = { candles: [{ time: 1764115200, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }] };
const analysis = (provider: string, opinion: string) => ({
  id: 1, key: 'coin:BTC-USDT', horizon: 'swing', provider, model: 'm', dataTime: Date.UTC(2026, 10, 26, 0, 0) / 1000, createdAt: 0,
  opinion, confidence: '중간', summary: '요약입니다', reasons: ['20일선 아래'], risks: ['변동성'], news: [{ title: '뉴스A', url: 'https://example.com/a', date: '2026-11-25' }],
});

function instrumentServer(over: Record<string, Parameters<typeof mockServer>[0][string]> = {}) {
  return mockServer({
    '/api/market/candles': () => candles,
    '/api/analysis/latest': () => ({ analyses: [] }),
    ...over,
  });
}

describe('chart', () => {
  test('candles are drawn at Korean time', async () => {
    instrumentServer();
    render(<CandleChart keyId="coin:BTC-USDT" bar="1D" onRangePick={vi.fn()} />);
    await waitFor(() => expect(chartState.data.length).toBe(1));
    expect((chartState.data[0] as { time: number }).time).toBe(1764115200 + KST_OFFSET);
  });

  test('chart load error shows Korean message', async () => {
    instrumentServer({ '/api/market/candles': () => new Response(JSON.stringify({ error: 'OKX 데이터를 가져오지 못했습니다' }), { status: 502 }) });
    render(<CandleChart keyId="coin:BTC-USDT" bar="1D" />);
    expect(await screen.findByText('OKX 데이터를 가져오지 못했습니다')).toBeTruthy();
  });
});

describe('instrument view', () => {
  test('horizon picker default is 스윙 and sends horizon=scalp on 단타', async () => {
    const s = instrumentServer({ 'POST /api/analysis': () => sseResponse([{ type: 'analysis', analysis: analysis('claude', '관망'), cached: false }, { type: 'done' }]) });
    render(<InstrumentView keyId="coin:BTC-USDT" onClose={() => {}} onChat={() => {}} />);
    expect((await screen.findByRole('radio', { name: '스윙' })).getAttribute('aria-checked')).toBe('true');
    await userEvent.click(screen.getByRole('radio', { name: '단타' }));
    await userEvent.click(screen.getByRole('button', { name: 'AI 타이밍 분석' }));
    await waitFor(() => expect(s.calls.find((c) => c.method === 'POST' && c.url.pathname === '/api/analysis')?.body).toEqual({ key: 'coin:BTC-USDT', horizon: 'scalp', provider: 'claude', deep: false }));
  });

  test('analysis panel shows opinion, confidence, horizon label and data time', async () => {
    instrumentServer({ '/api/analysis/latest': () => ({ analyses: [analysis('claude', '관망')] }) });
    render(<InstrumentView keyId="coin:BTC-USDT" onClose={() => {}} onChat={() => {}} />);
    expect(await screen.findByText('관망')).toBeTruthy();
    expect(screen.getByText(/확신 중간/)).toBeTruthy();
    expect(screen.getByText(/스윙 · 2026-11-26 09:00 기준|2026-11-26 09:00 기준/)).toBeTruthy();
    expect(screen.getByText('20일선 아래')).toBeTruthy();
    expect(screen.getByText('변동성')).toBeTruthy();
    expect(screen.getByRole('link', { name: '뉴스A' }).getAttribute('href')).toBe('https://example.com/a');
  });

  test('second opinion requests the other provider and shows both', async () => {
    const s = instrumentServer({
      '/api/analysis/latest': () => ({ analyses: [analysis('claude', '관망')] }),
      'POST /api/analysis': () => sseResponse([{ type: 'analysis', analysis: analysis('gpt', '매수'), cached: false }]),
    });
    render(<InstrumentView keyId="coin:BTC-USDT" onClose={() => {}} onChat={() => {}} />);
    await screen.findByText('관망');
    await userEvent.click(screen.getByRole('button', { name: '두 번째 의견' }));
    expect(await screen.findByText('매수')).toBeTruthy();
    expect(screen.getByText('관망')).toBeTruthy();
    expect(s.calls.find((c) => c.method === 'POST' && c.url.pathname === '/api/analysis')?.body).toMatchObject({ provider: 'gpt' });
  });

  test('streaming status shown while waiting', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    instrumentServer({
      'POST /api/analysis': async () => {
        const stream = new ReadableStream({
          async start(ctrl) {
            ctrl.enqueue(new TextEncoder().encode('event: status\ndata: {"type":"status","message":"차트 데이터를 불러오는 중…"}\n\n'));
            await gate;
            ctrl.close();
          },
        });
        return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
      },
    });
    render(<InstrumentView keyId="coin:BTC-USDT" onClose={() => {}} onChat={() => {}} />);
    await userEvent.click(await screen.findByRole('button', { name: 'AI 타이밍 분석' }));
    expect(await screen.findByText('차트 데이터를 불러오는 중…')).toBeTruthy();
    release();
  });

  test('budget error shows Korean message and re-enables buttons', async () => {
    instrumentServer({ 'POST /api/analysis': () => sseResponse([{ type: 'error', code: 'budget', message: '오늘 AI 사용 한도에 도달했습니다' }]) });
    render(<InstrumentView keyId="coin:BTC-USDT" onClose={() => {}} onChat={() => {}} />);
    const btn = await screen.findByRole('button', { name: 'AI 타이밍 분석' });
    await userEvent.click(btn);
    expect(await screen.findByText('오늘 AI 사용 한도에 도달했습니다')).toBeTruthy();
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
  });

  test('dragging across the chart opens the explanation for that stretch', async () => {
    const s = instrumentServer({ 'POST /api/explain-point': () => sseResponse([{ type: 'text', delta: '거래량 급증' }, { type: 'explanation', text: '거래량 급증', cached: false }]) });
    render(<InstrumentView keyId="coin:BTC-USDT" onClose={() => {}} onChat={() => {}} />);
    await waitFor(() => expect(chartState.data.length).toBe(1));
    const box = screen.getByRole('img', { name: /coin:BTC-USDT .+ 차트/ });
    const pointer = (type: string, x: number) => { const ev = new MouseEvent(type, { bubbles: true, clientX: x }); Object.defineProperty(ev, 'pointerId', { value: 1 }); box.dispatchEvent(ev); };
    pointer('pointerdown', 10);
    pointer('pointermove', 60);
    pointer('pointerup', 60);
    expect(await screen.findByRole('dialog', { name: '왜 움직였을까?' })).toBeTruthy();
    expect(await screen.findByText('거래량 급증')).toBeTruthy();
    expect(s.calls.find((c) => c.url.pathname === '/api/explain-point')?.body).toMatchObject({ key: 'coin:BTC-USDT', time: 1764115200 });
    await waitFor(() => expect(s.calls.some((c) => c.url.pathname === '/api/news' && c.url.searchParams.get('from') === '1764115200' && c.url.searchParams.get('to') === '1764115200')).toBe(true));
  });
});

describe('chat', () => {
  test('chat renders chart event as inline chart card and keeps chatId', async () => {
    const s = mockServer({
      '/api/market/candles': () => candles,
      'POST /api/chat': () => sseResponse([
        { type: 'chat', chatId: 7 },
        { type: 'chart', spec: { key: 'coin:ETH-USDT', bar: '4H', from: null, to: null, markers: [] } },
        { type: 'text', delta: '이렇게 보입니다' },
        { type: 'done', text: '이렇게 보입니다', provider: 'claude', model: 'm', costUsd: 0 },
      ]),
    });
    render(<ChatView keyId="coin:BTC-USDT" onClose={() => {}} />);
    await userEvent.type(screen.getByLabelText('메시지'), '차트 보여줘');
    await userEvent.click(screen.getByRole('button', { name: '보내기' }));
    expect(await screen.findByText('이렇게 보입니다')).toBeTruthy();
    expect(screen.getByLabelText('coin:ETH-USDT 4H 차트')).toBeTruthy();
    await userEvent.type(screen.getByLabelText('메시지'), '다음');
    await userEvent.click(screen.getByRole('button', { name: '보내기' }));
    await waitFor(() => expect(s.calls.filter((c) => c.url.pathname === '/api/chat')[1]?.body).toMatchObject({ chatId: 7, key: 'coin:BTC-USDT', provider: 'claude', text: '다음' }));
  });

  test('second opinion re-asks the same question with the other provider', async () => {
    const s = mockServer({ 'POST /api/chat': () => sseResponse([{ type: 'chat', chatId: 1 }, { type: 'text', delta: '답' }, { type: 'done', text: '답', provider: 'claude', model: 'm', costUsd: 0 }]) });
    render(<ChatView keyId={null} onClose={() => {}} />);
    await userEvent.type(screen.getByLabelText('메시지'), '살까?');
    await userEvent.click(screen.getByRole('button', { name: '보내기' }));
    await screen.findByText('답');
    await userEvent.click(screen.getByRole('button', { name: 'GPT 의견 듣기' }));
    await waitFor(() => expect(s.calls.filter((c) => c.url.pathname === '/api/chat')[1]?.body).toMatchObject({ provider: 'gpt', text: '살까?' }));
  });
});

const SETTINGS = {
  models: { claude: { light: 'claude-haiku-5-5', standard: 'claude-sonnet-5-5', deep: 'claude-opus-5-5' }, gpt: { light: 'gpt-6-luna', standard: 'gpt-6.1-sol', deep: 'gpt-6.2-sol' } },
  gptMode: 'siwc', budget: { scheduledDailyUsd: 1.5, interactiveDailyUsd: 3, monthlyUsd: 80, gptMonthlyUsd: 5 },
  keys: { claude: true, openai: false, okx: true, kis: true, push: true },
  apiKeys: { claude: { set: true, source: 'server', tail: 'AbCd' }, openai: { set: false, source: null, tail: null } },
};

describe('settings', () => {
  function settingsServer() {
    return mockServer({
      '/api/settings': () => SETTINGS,
      'PUT /api/settings': (_u, init) => ({ ...SETTINGS, ...JSON.parse(String(init?.body)) }),
      '/api/usage': () => ({ today: { interactive: 0.42, scheduled: 0.1 }, month: 3.2, gptMonth: 0, limits: {} }),
      '/api/admin/siwc-status': () => ({ connected: false, expiresAt: null }),
      'POST /api/admin/run-briefing': () => new Response(JSON.stringify({ started: true }), { status: 202 }),
    });
  }

  test('a saved key is never shown, only its last 4 characters; the key box starts empty', async () => {
    settingsServer();
    render(<SettingsView onClose={() => {}} />);
    expect(await screen.findByText(/연결됨 · 키 …AbCd \(서버 설정\)/)).toBeTruthy();
    const box = screen.getByLabelText('Claude API 키') as HTMLInputElement;
    expect(box.type).toBe('password');
    expect(box.value).toBe('');
  });

  test('shows usage and saves limits', async () => {
    const s = settingsServer();
    render(<SettingsView onClose={() => {}} />);
    expect(await screen.findByText(/\$3\.20/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '설정 저장' }));
    await waitFor(() => expect(s.calls.find((c) => c.method === 'PUT')?.body).toMatchObject({ budget: { monthlyUsd: 80 } }));
  });

  test('iOS push guidance shown when not standalone', async () => {
    settingsServer();
    render(<SettingsView onClose={() => {}} />);
    expect(await screen.findByText(/홈 화면에 추가한 앱에서만 알림을 받을 수 있어요/)).toBeTruthy();
  });

  test('run briefing now', async () => {
    const s = settingsServer();
    render(<SettingsView onClose={() => {}} />);
    await userEvent.click(await screen.findByRole('button', { name: '지금 브리핑 만들기' }));
    expect(await screen.findByText(/1분 정도 뒤/)).toBeTruthy();
    expect(s.calls.some((c) => c.method === 'POST' && c.url.pathname === '/api/admin/run-briefing')).toBe(true);
  });
});
