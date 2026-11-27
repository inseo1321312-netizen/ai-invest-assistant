import { afterEach, describe, expect, test, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CompareView } from '../src/components/CompareView';
import { resetAiReady } from '../src/aiReady';
import App from '../src/App';
import { mockServer, sseResponse } from './fakeServer';

afterEach(() => { vi.unstubAllGlobals(); resetAiReady(); sessionStorage.clear(); });

const SS = 'kr:005930';
const HX = 'kr:000660';
const AAPL = 'us:NAS:AAPL';
const BTC = 'coin:BTC-USDT';
const NAMES: Record<string, string> = { [SS]: '삼성전자', [HX]: 'SK하이닉스', [AAPL]: '애플', [BTC]: '비트코인' };
const QUOTES: Record<string, { price: number; changePct24h: number; currency: string }> = {
  [SS]: { price: 179500, changePct24h: 4.8, currency: 'KRW' }, [HX]: { price: 612000, changePct24h: 3.1, currency: 'KRW' },
  [AAPL]: { price: 355.1, changePct24h: -0.4, currency: 'USD' }, [BTC]: { price: 96000, changePct24h: -2, currency: 'USDT' },
};

function result(keys: string[], pick: string | null, over: Record<string, unknown> = {}) {
  return {
    id: 7, keys, names: Object.fromEntries(keys.map((k) => [k, NAMES[k]])), horizon: 'swing', provider: 'gpt', model: 'm',
    pick, confidence: '중간', summary: '20일선 위에서 다시 오르는 중이라 몇 주 보기엔 더 나아요',
    ranking: keys.map((k, i) => ({ key: k, rank: i + 1, opinion: i === 0 ? '매수' : '관망', reason: `${NAMES[k]} 이유`, risk: `${NAMES[k]} 위험` })),
    facts: Object.fromEntries(keys.map((k) => [k, { price: QUOTES[k]!.price, currency: QUOTES[k]!.currency, dayPct: QUOTES[k]!.changePct24h, monthPct: 10, yearPos: 80, aboveMa20: true }])),
    createdAt: 1, costUsd: 0, ...over,
  };
}

const picks = (keys: string[]) => localStorage.setItem('compare.pick', JSON.stringify({ keys: keys.map((key) => ({ key, name: NAMES[key] })), horizon: 'swing' }));

function server(extra: Parameters<typeof mockServer>[0] = {}) {
  return mockServer({
    '/api/ai/ready': () => ({ claude: false, gpt: true, preferred: 'gpt' }),
    '/api/compare/suggest': () => ({ items: [{ key: HX, name: 'SK하이닉스', source: 'holding' }] }),
    '/api/compare/history': () => ({ items: [] }),
    '/api/market/quote': (url) => { const k = url.searchParams.get('key') ?? ''; return { quote: { ...QUOTES[k], time: 0 }, name: NAMES[k] ?? null }; },
    '/api/overnight': () => ({ recap: null, settings: { sleep: '23:00', wake: '07:00', notify: true }, making: false, error: null, sleepTimes: [], wakeTimes: [] }),
    ...extra,
  });
}

describe('compare as VS', () => {
  test('the menu is 홈 · 비교 · AI 상담 · 설정', async () => {
    server({ '/api/me': () => ({ loggedIn: true }) });
    render(<App />);
    const nav = await screen.findByRole('navigation', { name: '메뉴' });
    expect(within(nav).getAllByRole('button').map((b) => b.textContent)).toEqual(['홈', '비교', 'AI 상담', '설정']);
    await userEvent.click(within(nav).getByRole('button', { name: '비교' }));
    expect(await screen.findByRole('region', { name: '비교' })).toBeTruthy();
  });

  test('two VS slots to start; a picked slot shows its price and today’s change; empty slots ask to add', async () => {
    picks([SS]);
    server();
    render(<CompareView seed={null} onOpen={() => {}} onAsk={() => {}} />);
    const vs = screen.getByRole('group', { name: '비교할 종목' });
    const slot = await within(vs).findByRole('group', { name: '삼성전자' });
    await waitFor(() => expect(slot.textContent).toContain('179,500원'));
    expect(slot.textContent).toContain('+4.8%');
    expect(within(vs).getByRole('button', { name: '종목 담기' })).toBeTruthy();
    expect((screen.getByRole('button', { name: 'AI에게 뭐가 나은지 묻기' }) as HTMLButtonElement).disabled).toBe(true);
  });

  test('plain-language horizon, default 몇 주, sent as scalp/swing/long', async () => {
    picks([SS, HX]);
    const s = server({ 'POST /api/compare': () => sseResponse([]) });
    render(<CompareView seed={null} onOpen={() => {}} onAsk={() => {}} />);
    const h = screen.getByRole('radiogroup', { name: '얼마나 들고 갈 건가요?' });
    expect(within(h).getAllByRole('radio').map((r) => r.textContent)).toEqual(['하루 안', '몇 주', '몇 달 이상']);
    expect(within(h).getByRole('radio', { name: '몇 주' }).getAttribute('aria-checked')).toBe('true');
    await userEvent.click(within(h).getByRole('radio', { name: '몇 달 이상' }));
    await userEvent.click(screen.getByRole('button', { name: 'AI에게 뭐가 나은지 묻기' }));
    await waitFor(() => expect(s.calls.find((c) => c.method === 'POST')?.body).toEqual({ keys: [SS, HX], horizon: 'long', provider: 'gpt' }));
  });

  test('the result: 1위 and a column table in rank order with the winner highlighted', async () => {
    picks([SS, HX]);
    server({ 'POST /api/compare': () => sseResponse([{ type: 'compare', result: result([HX, SS], HX), cached: false }]) });
    render(<CompareView seed={null} onOpen={() => {}} onAsk={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'AI에게 뭐가 나은지 묻기' }));
    const card = await screen.findByRole('region', { name: '비교 결과' });
    expect(card.textContent).toContain('1위 SK하이닉스');
    expect(card.textContent).toContain('20일선 위에서 다시 오르는 중이라');
    const table = within(card).getByRole('table', { name: '나란히 보기' });
    const heads = within(table).getAllByRole('columnheader').map((h) => h.textContent ?? '');
    expect(heads.slice(1).map((h) => h.replace(' ✓', ''))).toEqual(['SK하이닉스', '삼성전자']);
    expect(within(table).getAllByRole('columnheader')[1]!.className).toContain('win');
    expect(within(table).getAllByRole('rowheader').map((r) => r.textContent)).toEqual(['AI 의견', '오늘', '한 달', '52주 위치', '20일선', '이유', '위험']);
  });

  test('no pick: wait, nothing highlighted; asking more and the other AI use the result on screen', async () => {
    picks([SS, AAPL]);
    const r = result([HX, SS], null, { horizon: 'long', provider: 'claude' });
    sessionStorage.setItem('compare.last', JSON.stringify(r));
    const s = server({ 'POST /api/compare': () => sseResponse([]) });
    const onAsk = vi.fn();
    render(<CompareView seed={null} onOpen={() => {}} onAsk={onAsk} />);
    const card = await screen.findByRole('region', { name: '비교 결과' });
    expect(card.textContent).toContain('지금은 기다리기');
    expect(card.querySelector('th.win')).toBeNull();
    await userEvent.click(within(card).getByRole('button', { name: '이어서 묻기' }));
    expect(onAsk).toHaveBeenCalledWith('SK하이닉스·삼성전자 비교(몇 달 이상 기준)에서 지금은 기다리는 게 낫다고 나왔는데, ');
    await userEvent.click(within(card).getByRole('button', { name: '다른 AI에게도 묻기' }));
    await waitFor(() => expect(s.calls.find((c) => c.method === 'POST')?.body).toEqual({ keys: [HX, SS], horizon: 'long', provider: 'gpt' }));
  });

  test('with four picked a fifth waits for a free slot', async () => {
    picks([SS, HX, AAPL, BTC]);
    server();
    render(<CompareView seed="kr:035420" onOpen={() => {}} onAsk={() => {}} />);
    expect(await screen.findByText(/4개까지 담을 수 있어요/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '종목 추가' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: '애플 빼기' }));
    await waitFor(() => expect(JSON.parse(localStorage.getItem('compare.pick')!).keys.map((k: { key: string }) => k.key)).toContain('kr:035420'));
  });

  test('a stock page can put the stock into compare; chat opens with the drafted question and the cursor at the end', async () => {
    const { InstrumentView } = await import('../src/components/InstrumentView');
    const { ChatView } = await import('../src/components/ChatView');
    server({ '/api/chats': () => ({ chats: [{ id: 3, key: null, title: '예전', createdAt: Date.now() }] }) });
    const onCompare = vi.fn();
    const { unmount } = render(<InstrumentView keyId={SS} onClose={() => {}} onChat={() => {}} onCompare={onCompare} />);
    const chip = await screen.findByRole('button', { name: '비교에 담기' });
    expect(chip.closest('header')).toBeNull();
    await userEvent.click(chip);
    expect(onCompare).toHaveBeenCalledWith(SS);
    unmount();
    const text = 'SK하이닉스·삼성전자 비교(몇 주 기준)에서 SK하이닉스가 낫다고 나왔는데, ';
    render(<ChatView keyId={null} draft={text} />);
    const box = screen.getByRole('textbox', { name: '메시지' }) as HTMLTextAreaElement;
    expect(box.value).toBe(text);
    await waitFor(() => expect(box.selectionStart).toBe(text.length));
  });

  test('leaving the tab stops a running comparison', async () => {
    picks([SS, HX]);
    let signal: AbortSignal | undefined;
    server({ 'POST /api/compare': (_u, init) => { signal = init?.signal ?? undefined; return new Promise(() => {}); } });
    const { unmount } = render(<CompareView seed={null} onOpen={() => {}} onAsk={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'AI에게 뭐가 나은지 묻기' }));
    await waitFor(() => expect(signal).toBeDefined());
    unmount();
    expect(signal!.aborted).toBe(true);
  });
});
