import { afterEach, describe, expect, test, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CompareView } from '../src/components/CompareView';
import { resetAiReady } from '../src/aiReady';
import App from '../src/App';
import { mockServer, sseResponse } from './fakeServer';

afterEach(() => { vi.unstubAllGlobals(); resetAiReady(); });

const SS = 'kr:005930';
const HX = 'kr:000660';
const AAPL = 'us:NAS:AAPL';
const BTC = 'coin:BTC-USDT';
const NAMES: Record<string, string> = { [SS]: '삼성전자', [HX]: 'SK하이닉스', [AAPL]: '애플', [BTC]: '비트코인' };

function result(keys: string[], pick: string | null, facts: Record<string, unknown> = {}) {
  return {
    id: 7, keys, names: Object.fromEntries(keys.map((k) => [k, NAMES[k]])), horizon: 'swing', provider: 'gpt', model: 'gpt-x',
    pick, confidence: '중간', summary: '하이닉스 추세가 낫다.',
    ranking: keys.map((k, i) => ({ key: k, rank: i + 1, opinion: i === 0 ? '매수' : '관망', reason: `${NAMES[k]} 이유`, risk: `${NAMES[k]} 위험` })),
    facts, createdAt: 1, costUsd: 0,
  };
}

const picks = (keys: string[]) => localStorage.setItem('compare.pick', JSON.stringify({ keys: keys.map((key) => ({ key, name: NAMES[key] })), horizon: 'swing' }));

function server(extra: Record<string, (url: URL, init?: RequestInit) => unknown> = {}) {
  return mockServer({
    '/api/ai/ready': () => ({ claude: false, gpt: true, preferred: 'gpt' }),
    '/api/compare/suggest': () => ({ items: [{ key: HX, name: 'SK하이닉스', source: 'holding' }] }),
    '/api/compare/history': () => ({ items: [] }),
    '/api/market/quote': (url) => ({ quote: { price: 1, changePct24h: 0, currency: 'KRW', time: 0 }, name: NAMES[url.searchParams.get('key') ?? ''] ?? null }),
    ...extra,
  });
}

describe('compare tab', () => {
  test('the menu has a 비교 tab that opens the compare screen', async () => {
    server({ '/api/me': () => ({ loggedIn: true }) });
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: '비교' }));
    expect(await screen.findByRole('region', { name: '비교' })).toBeTruthy();
  });

  test('needs two picks; a quick pick from holdings adds one; a seeded stock already there is not added twice', async () => {
    picks([SS]);
    server();
    render(<CompareView seed={SS} onOpen={() => {}} onAsk={() => {}} />);
    const view = screen.getByRole('region', { name: '비교' });
    await waitFor(() => expect(within(view).getAllByRole('button', { name: /빼기$/ })).toHaveLength(1));
    expect((within(view).getByRole('button', { name: '비교하기' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(await within(view).findByRole('button', { name: 'SK하이닉스 담기' }));
    expect(within(view).getAllByRole('button', { name: /빼기$/ })).toHaveLength(2);
    expect((within(view).getByRole('button', { name: '비교하기' }) as HTMLButtonElement).disabled).toBe(false);
  });

  test('four picks is the most: no more adding', async () => {
    picks([SS, HX, AAPL, BTC]);
    server();
    render(<CompareView seed={null} onOpen={() => {}} onAsk={() => {}} />);
    await waitFor(() => expect(screen.getAllByRole('button', { name: /빼기$/ })).toHaveLength(4));
    expect(screen.queryByRole('button', { name: '종목 추가' })).toBeNull();
  });

  test('comparing shows the verdict, the ranking and each price in its own currency', async () => {
    picks([SS, AAPL, BTC]);
    const r = result([AAPL, SS, BTC], AAPL, {
      [SS]: { price: 179500, currency: 'KRW', dayPct: 4.8, monthPct: 10.2, yearPos: 92, aboveMa20: true },
      [AAPL]: { price: 355.1, currency: 'USD', dayPct: -0.4, monthPct: 2.1, yearPos: 70, aboveMa20: false },
      [BTC]: { price: 96000, currency: 'USDT', dayPct: -2, monthPct: -5.5, yearPos: 40, aboveMa20: false },
    });
    const s = server({ 'POST /api/compare': () => sseResponse([{ type: 'status', message: 'AI가 비교하는 중…' }, { type: 'compare', result: r, cached: false }]) });
    render(<CompareView seed={null} onOpen={() => {}} onAsk={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: '비교하기' }));
    const card = await screen.findByRole('region', { name: '비교 결과' });
    expect(card.textContent).toContain('지금은 애플');
    expect(within(card).getByRole('list', { name: '순위' }).textContent).toMatch(/1.*애플.*애플 이유.*애플 위험.*2.*삼성전자/s);
    const table = within(card).getByRole('table', { name: '나란히 보기' });
    expect(table.textContent).toContain('179,500원');
    expect(table.textContent).toContain('$355.10');
    expect(table.textContent).toContain('96,000 USDT');
    expect(s.calls.find((c) => c.method === 'POST')?.body).toEqual({ keys: [SS, AAPL, BTC], horizon: 'swing', provider: 'gpt' });
  });

  test('no pick means wait, and asking more hands the verdict to AI chat', async () => {
    picks([SS, HX]);
    server({ 'POST /api/compare': () => sseResponse([{ type: 'compare', result: result([HX, SS], null), cached: false }]) });
    const onAsk = vi.fn();
    render(<CompareView seed={null} onOpen={() => {}} onAsk={onAsk} />);
    await userEvent.click(screen.getByRole('button', { name: '비교하기' }));
    const card = await screen.findByRole('region', { name: '비교 결과' });
    expect(card.textContent).toContain('지금은 기다리기');
    await userEvent.click(within(card).getByRole('button', { name: '이어서 묻기' }));
    expect(onAsk).toHaveBeenCalledWith('SK하이닉스·삼성전자 스윙 비교에서 지금은 기다리는 게 낫다고 나왔는데, ');
  });

  test('asking more after a pick names the pick', async () => {
    picks([SS, HX]);
    server({ 'POST /api/compare': () => sseResponse([{ type: 'compare', result: result([HX, SS], HX), cached: false }]) });
    const onAsk = vi.fn();
    render(<CompareView seed={null} onOpen={() => {}} onAsk={onAsk} />);
    await userEvent.click(screen.getByRole('button', { name: '비교하기' }));
    await userEvent.click(await screen.findByRole('button', { name: '이어서 묻기' }));
    expect(onAsk).toHaveBeenCalledWith('SK하이닉스·삼성전자 스윙 비교에서 SK하이닉스가 낫다고 나왔는데, ');
  });

  test('a past comparison opens again from the list', async () => {
    picks([SS, HX]);
    server({
      '/api/compare/history': () => ({ items: [{ id: 7, keys: [HX, SS], names: { [HX]: 'SK하이닉스', [SS]: '삼성전자' }, horizon: 'long', provider: 'claude', pick: HX, createdAt: Date.now() }] }),
      '/api/compare/7': () => ({ result: result([HX, SS], HX) }),
    });
    render(<CompareView seed={null} onOpen={() => {}} onAsk={() => {}} />);
    const past = await screen.findByRole('list', { name: '지난 비교' });
    await userEvent.click(within(past).getByRole('button', { name: /SK하이닉스 · 삼성전자/ }));
    expect((await screen.findByRole('region', { name: '비교 결과' })).textContent).toContain('지금은 SK하이닉스');
  });

  test('leaving the tab stops a comparison that is still running', async () => {
    picks([SS, HX]);
    let signal: AbortSignal | undefined;
    server({ 'POST /api/compare': (_u, init) => { signal = init?.signal ?? undefined; return new Promise(() => {}); } });
    const { unmount } = render(<CompareView seed={null} onOpen={() => {}} onAsk={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: '비교하기' }));
    await waitFor(() => expect(signal).toBeDefined());
    unmount();
    expect(signal!.aborted).toBe(true);
  });
});
