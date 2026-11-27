import { afterEach, describe, expect, test, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OvernightView } from '../src/components/OvernightView';
import App from '../src/App';
import { mockServer } from './fakeServer';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const KST = (s: string) => Date.parse(`${s}+09:00`);
const BTC = 'coin:BTC-USDT';
const AAPL = 'us:NAS:AAPL';
const SS = 'kr:005930';
const SETTINGS = { sleep: '23:00', wake: '07:00', notify: true };
const TIMES = { sleepTimes: ['21:00', '21:30', '22:00', '22:30', '23:00', '23:30', '00:00', '00:30', '01:00', '01:30', '02:00'], wakeTimes: ['06:00', '06:30', '07:00', '07:30', '08:00', '08:30', '09:00', '09:30', '10:00', '10:30', '11:00'] };

function recap(over: Record<string, unknown> = {}) {
  return {
    id: 5, day: '2026-11-28', from: KST('2026-11-27T23:00:00'), to: KST('2026-11-28T07:00:00'), origin: 'scheduled', provider: 'claude', model: 'm', createdAt: KST('2026-11-28T07:01:00'), costUsd: 0,
    headline: '나스닥 +1.2% 마감, 비트코인은 밤새 -2.9%',
    points: ['나스닥 +1.2%로 마감, 반도체 강세', '비트코인 새벽 3시 급락 후 반등 중', '원/달러 1,338원'],
    items: [{ key: BTC, note: 'ETF 자금 유출' }, { key: AAPL, note: '실적 기대감' }, { key: SS, note: '美 반도체 강세가 오늘 호재' }],
    news: [{ n: 2, why: '비트코인 하락의 이유' }],
    today: ['9시 개장', '오늘 밤 美 고용지표'],
    facts: {
      market: { spx: { value: 6012.5, changePct: 0.8 }, nasdaq: { value: 19250.1, changePct: 1.2 }, btc: { from: 96800, to: 94000, pct: -2.89, high: 97100, low: 93500 }, usdkrw: 1338.2, kimchi: 0.57, metals: { gold: { value: 3671, changePct: 3.82 }, silver: { value: 43.72, changePct: -1.2 }, copper: { value: 5.5635, changePct: 0.4 } } },
      items: [
        { key: BTC, name: '비트코인', market: 'coin', price: 94000, fromPrice: 96800, currency: 'USDT', pct: -2.89, kind: 'night', extended: null },
        { key: AAPL, name: '애플', market: 'us', price: 361.2, fromPrice: 355.1, currency: 'USD', pct: 1.72, kind: 'session', extended: null },
        { key: SS, name: '삼성전자', market: 'kr', price: 179500, fromPrice: null, currency: 'KRW', pct: 4.8, kind: 'closed', extended: null },
      ],
      news: [
        { n: 1, title: '뉴욕증시 혼조', url: 'https://n/1', source: '연합', publishedAt: KST('2026-11-28T06:10:00') / 1000, key: null },
        { n: 2, title: '비트코인 ETF 자금 유출', url: 'https://n/2', source: '코인데스크', publishedAt: KST('2026-11-28T03:00:00') / 1000, key: BTC },
      ],
    },
    ...over,
  };
}

function server(view: Record<string, unknown>, extra: Parameters<typeof mockServer>[0] = {}) {
  return mockServer({
    '/api/overnight': () => ({ recap: null, settings: SETTINGS, making: false, error: null, ...TIMES, ...view }),
    '/api/overnight/history': () => ({ items: [] }),
    ...extra,
  });
}

describe('밤사이 tab', () => {
  test('shows the range, the AI summary, markets, my stocks, news and today, as sketched', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now: KST('2026-11-28T08:00:00') });
    server({ recap: recap() });
    const onOpen = vi.fn();
    render(<OvernightView onOpen={onOpen} />);
    const view = await screen.findByRole('region', { name: '밤사이' });
    expect(await within(view).findByText('어젯밤 11:00 ~ 오늘 7:00')).toBeTruthy();
    expect(within(view).getByRole('button', { name: '정리 설정' }).textContent).toContain('7:00 정리');

    const summary = within(view).getByRole('region', { name: 'AI 정리' });
    expect(summary.textContent).toContain('나스닥 +1.2% 마감, 비트코인은 밤새 -2.9%');
    expect(within(summary).getAllByRole('listitem')).toHaveLength(3);

    const market = within(view).getByRole('region', { name: '시장' });
    expect(market.textContent).toContain('+1.20%');
    expect(market.textContent).toContain('96,800 → 94,000 USDT');
    expect(market.textContent).toContain('-2.9%');
    expect(market.textContent).toContain('최고 97,100');
    expect(market.textContent).toContain('1,338.2원');
    expect(within(market).getByRole('group', { name: '금' }).textContent).toMatch(/\$3,671.*\+3\.82%/);
    expect(within(market).getByRole('group', { name: '구리' }).textContent).toContain('$5.56');

    const mine = within(view).getByRole('region', { name: '내 종목 밤사이' });
    expect(mine.textContent).toContain('$355.10 → $361.20');
    expect(mine.textContent).toContain('+1.7%');
    expect(mine.textContent).toContain('밤엔 거래 없음');
    expect(mine.textContent).toContain('美 반도체 강세가 오늘 호재');
    await userEvent.click(within(mine).getByRole('button', { name: /애플/ }));
    expect(onOpen).toHaveBeenCalledWith(AAPL);

    const news = within(view).getByRole('region', { name: '밤사이 주요 뉴스' });
    const link = within(news).getByRole('link', { name: /비트코인 ETF 자금 유출/ });
    expect(link.getAttribute('href')).toBe('https://n/2');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(news.textContent).toContain('비트코인 하락의 이유');
    expect(news.textContent).not.toContain('뉴욕증시 혼조');

    expect(within(view).getByRole('region', { name: '오늘 볼 것' }).textContent).toContain('오늘 밤 美 고용지표');
  });

  test('before the first recap it says when it will be made, and 지금 정리 starts one and waits for it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let made = false;
    let making = false;
    const s = server({}, {
      '/api/overnight': () => ({ recap: made ? recap() : null, settings: SETTINGS, making, error: null, ...TIMES }),
      'POST /api/overnight/run': () => { making = true; return { making: true }; },
    });
    render(<OvernightView onOpen={() => {}} />);
    expect(await screen.findByText('7:00에 정리돼요')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '지금 정리' }));
    expect(await screen.findByText(/정리하는 중/)).toBeTruthy();
    expect(s.calls.some((c) => c.method === 'POST' && c.url.pathname === '/api/overnight/run')).toBe(true);
    made = true;
    making = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(5100); });
    expect(await screen.findByText('나스닥 +1.2% 마감, 비트코인은 밤새 -2.9%')).toBeTruthy();
  });

  test('an error is shown with a way to try again, not a spinner forever', async () => {
    server({ error: '밤사이 정리를 만들지 못했어요' });
    render(<OvernightView onOpen={() => {}} />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('밤사이 정리를 만들지 못했어요');
    expect(screen.getByRole('button', { name: '다시 정리' })).toBeTruthy();
    expect(screen.queryByText(/정리하는 중/)).toBeNull();
  });

  test('settings: pick bedtime and wake time from half-hour lists, turn the push off, save', async () => {
    const s = server({ recap: recap() }, { 'PUT /api/overnight/settings': () => ({ settings: { sleep: '00:30', wake: '06:30', notify: false } }) });
    render(<OvernightView onOpen={() => {}} />);
    await userEvent.click(await screen.findByRole('button', { name: '정리 설정' }));
    const sheet = await screen.findByRole('dialog', { name: '밤사이 설정' });
    const sleep = within(sheet).getByLabelText('잠드는 시간') as HTMLSelectElement;
    const wake = within(sheet).getByLabelText('정리 시각') as HTMLSelectElement;
    expect([...wake.options].map((o) => o.value)).toEqual(TIMES.wakeTimes);
    await userEvent.selectOptions(sleep, '00:30');
    await userEvent.selectOptions(wake, '06:30');
    await userEvent.click(within(sheet).getByRole('checkbox', { name: '알림 받기' }));
    await userEvent.click(within(sheet).getByRole('button', { name: '저장' }));
    await waitFor(() => expect(s.calls.find((c) => c.method === 'PUT')?.body).toEqual({ sleep: '00:30', wake: '06:30', notify: false }));
    expect(await screen.findByRole('button', { name: '정리 설정' })).toHaveProperty('textContent', expect.stringContaining('6:30 정리'));
  });

  test('a past recap opens from the list', async () => {
    server({ recap: recap() }, {
      '/api/overnight/history': () => ({ items: [{ id: 4, day: '2026-11-27', from: KST('2026-11-26T23:00:00'), to: KST('2026-11-27T07:00:00'), origin: 'scheduled', headline: '어제 정리 제목' }] }),
      '/api/overnight/4': () => ({ recap: recap({ id: 4, day: '2026-11-27', headline: '어제 정리 제목' }) }),
    });
    render(<OvernightView onOpen={() => {}} />);
    const past = await screen.findByRole('list', { name: '지난 정리' });
    await userEvent.click(within(past).getByRole('button', { name: /어제 정리 제목/ }));
    expect(await screen.findByRole('heading', { name: '어제 정리 제목' })).toBeTruthy();
  });
});

describe('review fixes', () => {
  test('coming back to the app re-reads the recap (and so makes today’s if it is due)', async () => {
    const s = server({ recap: recap() });
    render(<OvernightView onOpen={() => {}} />);
    await screen.findByRole('region', { name: 'AI 정리' });
    const before = s.calls.filter((c) => c.url.pathname === '/api/overnight').length;
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await waitFor(() => expect(s.calls.filter((c) => c.url.pathname === '/api/overnight').length).toBe(before + 1));
  });

  test('a failed check while making keeps checking instead of freezing', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let n = 0;
    server({}, { '/api/overnight': () => {
      n++;
      if (n === 1) return { recap: null, settings: SETTINGS, making: true, error: null, ...TIMES };
      if (n === 2) return new Response('{}', { status: 502 });
      return { recap: recap(), settings: SETTINGS, making: false, error: null, ...TIMES };
    } });
    render(<OvernightView onOpen={() => {}} />);
    expect(await screen.findByText(/정리하는 중/)).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(5100); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5100); });
    expect(await screen.findByText('나스닥 +1.2% 마감, 비트코인은 밤새 -2.9%')).toBeTruthy();
  });

  test('a Korean stock trading now shows today’s move; a US stock with no session says the market was closed', async () => {
    const r = recap();
    r.facts.items = [
      { key: SS, name: '삼성전자', market: 'kr', price: 181000, fromPrice: 179500, currency: 'KRW', pct: 0.84, kind: 'today', extended: null },
      { key: AAPL, name: '애플', market: 'us', price: 361.2, fromPrice: null, currency: 'USD', pct: 1.72, kind: 'closed', extended: null },
    ] as never;
    (r.facts.market.spx as Record<string, unknown>).traded = false;
    server({ recap: r });
    render(<OvernightView onOpen={() => {}} />);
    const mine = await screen.findByRole('region', { name: '내 종목 밤사이' });
    expect(mine.textContent).toContain('장중');
    expect(mine.textContent).toContain('179,500 → 181,000원');
    expect(mine.textContent).toContain('미국장 휴장');
    expect(screen.getByRole('region', { name: '시장' }).textContent).toContain('미국장 휴장');
  });

  test('an error next to an older recap shows one 다시 정리, not two', async () => {
    server({ recap: recap(), error: '밤사이 정리를 만들지 못했어요' });
    render(<OvernightView onOpen={() => {}} />);
    await screen.findByRole('alert');
    expect(screen.getAllByRole('button', { name: /다시 정리/ })).toHaveLength(1);
  });

  test('pickers keep their arrow and long prices do not squeeze the name', async () => {
    const { readFileSync } = await import('node:fs');
    const css = readFileSync('src/styles.css', 'utf8');
    expect(css).not.toMatch(/\.field select \{ appearance: none/);
    expect(css).toMatch(/\.on-item-move \{[^}]*max-width: 48%/);
  });
});
