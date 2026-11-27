import { afterEach, expect, test, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NewsTicker } from '../src/components/NewsTicker';
import { Holdings } from '../src/components/Holdings';
import { mockServer, quote } from './fakeServer';

afterEach(() => vi.unstubAllGlobals());

const news = [
  { key: 'coin:BTC-USDT', name: '비트코인', title: '비트코인 급등', url: 'https://news.example/1', source: 'A', publishedAt: 1 },
  { key: 'kr:005930', name: '삼성전자', title: '삼성 실적 발표', url: 'https://news.example/2', source: 'B', publishedAt: 0 },
];

test('today news scrolls the news of favorites and holdings; each one opens the article', async () => {
  mockServer({ '/api/news/mine': () => ({ items: news }) });
  render(<NewsTicker />);
  const strip = await screen.findByRole('region', { name: '오늘 소식' });
  const links = await within(strip).findAllByRole('link');
  expect(links[0]!.getAttribute('href')).toBe('https://news.example/1');
  expect(links[0]!.getAttribute('target')).toBe('_blank');
  expect(links[0]!.textContent).toContain('비트코인');
  expect(links[0]!.textContent).toContain('비트코인 급등');
  expect(strip.querySelector('.marquee')).not.toBeNull();
});

test('with no favorites or holdings it says what to do', async () => {
  mockServer({ '/api/news/mine': () => ({ items: [] }) });
  render(<NewsTicker />);
  expect(await screen.findByText(/즐겨찾기나 보유 종목을 넣으면/)).toBeTruthy();
});

const holding = (over: Record<string, unknown>) => ({
  key: 'kr:005930', market: 'kr', name: '삼성전자', quantity: 10, avgPrice: 160000, addedAt: 1,
  instrument: { market: 'kr', symbol: '005930', kind: 'stock', exchange: null, name: '삼성전자' },
  quote: quote(171500, 0.5, 'KRW'), plPct: 7.1875, ...over,
});

test('holdings of this market show quantity and profit; edit lets you remove one', async () => {
  const s = mockServer({
    '/api/holdings': () => ({ items: [holding({}), holding({ key: 'us:NAS:AAPL', market: 'us', name: '애플', instrument: { market: 'us', symbol: 'AAPL', kind: 'stock', exchange: 'NAS', name: '애플' } })] }),
    'DELETE /api/holdings': () => ({ ok: true }),
  });
  const onOpen = vi.fn();
  render(<Holdings market="kr" onOpen={onOpen} />);
  const section = await screen.findByRole('region', { name: '보유 종목' });
  expect(within(section).getByText(/10주/)).toBeTruthy();
  expect(within(section).getByText('+7.2%')).toBeTruthy();
  expect(within(section).queryByText('애플')).toBeNull();
  await userEvent.click(within(section).getByRole('button', { name: '편집' }));
  await userEvent.click(within(section).getByRole('button', { name: '삼성전자 보유 종목에서 빼기' }));
  await waitFor(() => expect(s.calls.some((c) => c.method === 'DELETE' && c.url.searchParams.get('key') === 'kr:005930')).toBe(true));
  expect(screen.queryByRole('region', { name: '보유 종목' })).toBeNull();
});

test('no holdings in this market: the section stays hidden', async () => {
  mockServer({ '/api/holdings': () => ({ items: [] }) });
  render(<Holdings market="coin" onOpen={() => {}} />);
  await new Promise((r) => setTimeout(r, 30));
  expect(screen.queryByRole('region', { name: '보유 종목' })).toBeNull();
});
