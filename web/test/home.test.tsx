import { afterEach, describe, expect, test, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockServer, overview, quote } from './fakeServer';
import { SearchSheet } from '../src/components/SearchSheet';
import { MarketOverview } from '../src/components/MarketOverview';
import { Trending } from '../src/components/Trending';
import { WatchList } from '../src/components/WatchList';

afterEach(() => vi.unstubAllGlobals());

const samsung = { key: 'kr:005930', market: 'kr', name: '삼성전자', symbol: '005930' };

describe('search', () => {
  test('typing part of a name lists matches; tapping one opens it', async () => {
    const s = mockServer({ '/api/search': (url) => ({ hits: url.searchParams.get('q') === '삼' ? [samsung, { key: 'kr:006400', market: 'kr', name: '삼성SDI', symbol: '006400' }] : [] }) });
    const onOpen = vi.fn();
    const onClose = vi.fn();
    render(<SearchSheet onOpen={onOpen} onClose={onClose} />);
    const dialog = screen.getByRole('dialog', { name: '종목 검색' });
    await userEvent.type(within(dialog).getByLabelText('종목 이름'), '삼');
    const row = await within(dialog).findByRole('button', { name: /삼성전자 005930/ }, { timeout: 1000 });
    expect(within(row).getByText('한국')).toBeTruthy();
    await userEvent.click(row);
    expect(onOpen).toHaveBeenCalledWith('kr:005930');
    expect(onClose).toHaveBeenCalled();
    expect(s.calls.filter((c) => c.url.pathname === '/api/search').every((c) => c.url.searchParams.get('q') === '삼')).toBe(true);
  });

  test('the star adds the result to favorites', async () => {
    const s = mockServer({ '/api/search': () => ({ hits: [samsung] }), 'POST /api/watchlist': () => ({ ok: true }) });
    render(<SearchSheet onOpen={() => {}} onClose={() => {}} />);
    await userEvent.type(screen.getByLabelText('종목 이름'), '삼성');
    const star = await screen.findByRole('button', { name: '삼성전자 즐겨찾기' }, { timeout: 1000 });
    await userEvent.click(star);
    await waitFor(() => expect(s.calls.find((c) => c.method === 'POST')?.body).toEqual({ key: 'kr:005930' }));
    expect(star.getAttribute('aria-pressed')).toBe('true');
  });

  test('stars are already on for existing favorites', async () => {
    mockServer({ '/api/search': () => ({ hits: [samsung] }), '/api/watchlist': () => ({ keys: ['kr:005930'] }) });
    render(<SearchSheet onOpen={() => {}} onClose={() => {}} />);
    await userEvent.type(screen.getByLabelText('종목 이름'), '삼성');
    const star = await screen.findByRole('button', { name: '삼성전자 즐겨찾기' }, { timeout: 1000 });
    await waitFor(() => expect(star.getAttribute('aria-pressed')).toBe('true'));
  });

  test('clearing the box right away does not leave the spinner on', async () => {
    mockServer({ '/api/search': () => ({ hits: [] }) });
    render(<SearchSheet onOpen={() => {}} onClose={() => {}} />);
    const box = screen.getByLabelText('종목 이름');
    await userEvent.type(box, 'a');
    await userEvent.clear(box);
    await new Promise((res) => setTimeout(res, 300));
    expect(screen.queryByText(/찾는 중/)).toBeNull();
  });

  test('no matches says so', async () => {
    mockServer({ '/api/search': () => ({ hits: [] }) });
    render(<SearchSheet onOpen={() => {}} onClose={() => {}} />);
    await userEvent.type(screen.getByLabelText('종목 이름'), 'zzzz');
    expect(await screen.findByText(/찾는 종목이 없어요/, {}, { timeout: 1000 })).toBeTruthy();
  });
});

describe('market overview', () => {
  test('shows each item, with a dash when a value is missing', async () => {
    mockServer({ '/api/market-overview': () => ({ items: [
      { id: 'kospi', label: '코스피', value: 2650.12, changePct: 0.45, note: null },
      { id: 'nasdaq', label: '나스닥', value: null, changePct: null, note: null },
      { id: 'fng', label: '공포·탐욕', value: 11, changePct: null, note: '극도의 공포' },
      { id: 'kimchi', label: '김치 프리미엄', value: 1.25, changePct: null, note: null },
    ] }) });
    render(<MarketOverview />);
    const card = await screen.findByRole('region', { name: '오늘 시장 한눈에' });
    const kospi = await within(card).findByRole('group', { name: '코스피' });
    expect(kospi.textContent).toContain('2,650.12');
    expect(kospi.textContent).toContain('+0.45%');
    expect(within(card).getByRole('group', { name: '나스닥' }).textContent).toContain('—');
    expect(within(card).getByRole('group', { name: '공포·탐욕' }).textContent).toContain('극도의 공포');
    expect(within(card).getByRole('group', { name: '김치 프리미엄' }).textContent).toContain('+1.25%');
  });
});

describe('trending', () => {
  const item = (key: string, name: string, pct: number) => ({ key, name, symbol: key.split(':').pop(), price: 1.5, changePct: pct, value: 1e6, currency: 'USDT' });

  test('shows gainers, switches to trading value, and opens an item', async () => {
    const s = mockServer({ '/api/trending/coin': (url) => ({ items: url.searchParams.get('kind') === 'value' ? [item('coin:BTC-USDT', '비트코인', 1)] : [item('coin:SSV-USDT', 'SSV', 39.9), item('coin:MOVE-USDT', 'MOVE', 30.5)] }) });
    const onOpen = vi.fn();
    render(<Trending market="coin" onOpen={onOpen} />);
    const region = await screen.findByRole('region', { name: '지금 뜨는' });
    expect(await within(region).findByRole('button', { name: /SSV/ })).toBeTruthy();
    expect(within(region).getByRole('button', { name: /SSV/ }).textContent).toContain('+39.9%');
    await userEvent.click(within(region).getByRole('button', { name: '거래대금' }));
    await userEvent.click(await within(region).findByRole('button', { name: /비트코인/ }));
    expect(onOpen).toHaveBeenCalledWith('coin:BTC-USDT');
    expect(s.calls.some((c) => c.url.searchParams.get('kind') === 'value')).toBe(true);
  });

  test('stock rankings need the KIS key', async () => {
    mockServer({ '/api/trending/kr': () => ({ items: [], needsKey: true }) });
    render(<Trending market="kr" onOpen={() => {}} />);
    expect(await screen.findByText(/한투 앱키를 넣으면/)).toBeTruthy();
  });

  test('with the key set, an empty ranking does not ask for the key', async () => {
    mockServer({ '/api/trending/us': () => ({ items: [], needsKey: false }) });
    render(<Trending market="us" onOpen={() => {}} />);
    expect(await screen.findByText(/순위를 불러오지 못했어요/)).toBeTruthy();
    expect(screen.queryByText(/한투 앱키를 넣으면/)).toBeNull();
  });
});

describe('watch list', () => {
  const view = (key: string, name: string) => ({ key, instrument: { market: 'coin', symbol: key.slice(5), kind: 'spot', exchange: null, name }, quote: quote(100, 2), krwValue: 140000, badge: null });

  test('the home list is 즐겨찾기: starred stocks only', async () => {
    mockServer({ '/api/market/coin/overview': () => overview({ favorites: [view('coin:BTC-USDT', '비트코인')], recent: [view('coin:ETH-USDT', '이더리움')] }), '/api/market/sparklines': () => ({ sparklines: {} }) });
    render(<WatchList market="coin" onOpen={() => {}} />);
    expect(await screen.findByRole('heading', { name: '즐겨찾기' })).toBeTruthy();
    const list = await screen.findByRole('list', { name: '즐겨찾기' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain('비트코인');
    expect(screen.queryByText(/자주 보는|최근 본 종목/)).toBeNull();
  });

  test('empty list explains how to fill it', async () => {
    mockServer({ '/api/market/kr/overview': () => overview() });
    render(<WatchList market="kr" onOpen={() => {}} />);
    expect(await screen.findByText('종목 화면에서 ☆을 누르면 여기에 모여요')).toBeTruthy();
  });
});

describe('fear & greed', () => {
  test('is colored by its level and shows where it sits on a fear-to-greed bar', async () => {
    mockServer({ '/api/market-overview': () => ({ items: [
      { id: 'fng', label: '공포·탐욕', value: 11, changePct: null, note: '극도의 공포' },
    ] }) });
    render(<MarketOverview />);
    const tile = await screen.findByRole('group', { name: '공포·탐욕' });
    expect(tile.className).toContain('fng-fear-x');
    expect(tile.textContent).toContain('극도의 공포');
    const mark = tile.querySelector('.fng-bar > b') as HTMLElement;
    expect(mark.style.left).toBe('11%');
  });

  test('greed gets the greed color, the middle stays neutral', async () => {
    mockServer({ '/api/market-overview': () => ({ items: [
      { id: 'fng', label: '공포·탐욕', value: 81, changePct: null, note: '극도의 탐욕' },
    ] }) });
    render(<MarketOverview />);
    expect((await screen.findByRole('group', { name: '공포·탐욕' })).className).toContain('fng-greed-x');
  });
});
