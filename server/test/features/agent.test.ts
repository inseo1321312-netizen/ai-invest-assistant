import { expect, test } from 'vitest';
import { openDb } from '../../src/db.js';
import { createMarketService } from '../../src/market/service.js';
import { parseInstrumentKey } from '../../src/market/types.js';
import { listHoldings, removeHolding, saveHolding } from '../../src/features/holdings.js';
import { buildAgentTools } from '../../src/features/agentTools.js';
import { myNews } from '../../src/features/myNews.js';
import { chatTurn } from '../../src/features/chat.js';
import { fakeKis, fakeOkx } from '../market/fakes.js';
import { fakeRunAi } from '../ai/fakeRunAi.js';
import { makeClock } from '../helpers.js';

const NOW = Date.UTC(2026, 10, 27, 3, 0);

function setup() {
  const db = openDb(':memory:');
  const clock = makeClock(NOW);
  const okx = fakeOkx({ async getQuote(instId) { return { instrument: parseInstrumentKey(`coin:${instId}`), price: 100, changePct24h: 1, currency: 'USDT', time: 0 }; } });
  const kis = fakeKis({ async getQuote(inst) { return { instrument: inst, price: 171500, changePct24h: 0.5, currency: 'KRW', time: 0 }; } });
  const market = createMarketService({ db, okx, kis, now: clock.now, fx: async () => 1345 });
  const names: Record<string, string> = { 'kr:005930': '삼성전자', 'us:NAS:AAPL': '애플', 'coin:BTC-USDT': '비트코인' };
  const instruments = {
    nameOf: (k: string) => names[k] ?? null,
    async search(q: string) {
      return Object.entries(names).filter(([, n]) => n.includes(q)).map(([key, name]) => ({ key, name, market: key.split(':')[0], symbol: key.split(':').at(-1)! }));
    },
  };
  return { db, clock, market, instruments };
}

test('holdings: save, update quantity, list newest first with names, remove', () => {
  const { db, clock, instruments } = setup();
  saveHolding(db, 'kr:005930', { quantity: 10, avgPrice: 70000 }, clock.now());
  clock.advance(1000);
  saveHolding(db, 'us:NAS:AAPL', { quantity: null, avgPrice: null }, clock.now());
  saveHolding(db, 'kr:005930', { quantity: 15, avgPrice: null }, clock.now());
  const list = listHoldings(db, instruments);
  expect(list.map((h) => [h.key, h.name, h.quantity, h.avgPrice])).toEqual([
    ['us:NAS:AAPL', '애플', null, null],
    ['kr:005930', '삼성전자', 15, 70000],
  ]);
  removeHolding(db, 'kr:005930');
  expect(listHoldings(db, instruments).map((h) => h.key)).toEqual(['us:NAS:AAPL']);
});

test('agent tools find a stock by name and add it to holdings and favorites', async () => {
  const { db, clock, market, instruments } = setup();
  const tools = buildAgentTools({ db, market, instruments, now: clock.now });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  expect(Object.keys(byName).sort()).toEqual(['add_favorite', 'add_holding', 'find_instrument', 'list_holdings', 'remove_favorite', 'remove_holding']);
  const emitted: unknown[] = [];
  const ctx = { emit: (e: unknown) => emitted.push(e) };
  expect(JSON.parse(await byName.find_instrument!.run({ query: '삼성' }, ctx))).toEqual([{ key: 'kr:005930', name: '삼성전자', market: 'kr' }]);
  const added = await byName.add_holding!.run({ key: 'kr:005930', quantity: 10, avgPrice: null }, ctx);
  expect(added).toContain('삼성전자');
  expect(listHoldings(db, instruments)[0]).toMatchObject({ key: 'kr:005930', quantity: 10 });
  expect(emitted).toContainEqual({ type: 'status', message: '삼성전자를 보유 종목에 넣었어요 (10주)' });
  await byName.add_favorite!.run({ key: 'us:NAS:AAPL' }, ctx);
  expect(market.listWatchlist('us').map((i) => i.symbol)).toEqual(['AAPL']);
  await expect(byName.add_holding!.run({ key: 'nonsense', quantity: null, avgPrice: null }, ctx)).rejects.toThrow();
});

test('chat gives the AI the agent tools', async () => {
  const { db, clock, market, instruments } = setup();
  const ai = fakeRunAi([[{ text: '넣었어요' }]]);
  for await (const _ of chatTurn({ db, market, runAi: ai.runAi, now: clock.now, instruments }, { chatId: null, key: null, provider: 'claude', text: '삼성전자 10주 있어' })) { /* 끝까지 */ }
  const names = ai.requests[0]!.tools.map((t) => t.name);
  expect(names).toEqual(expect.arrayContaining(['find_instrument', 'add_holding', 'get_candles']));
});

test('my news: favorites and holdings, newest first, no duplicates, tagged with the stock name', async () => {
  const { db, clock, market, instruments } = setup();
  market.addWatch('coin:BTC-USDT');
  saveHolding(db, 'kr:005930', { quantity: 1, avgPrice: null }, clock.now());
  const t = NOW / 1000;
  const news = {
    async search(q: string) {
      if (q.startsWith('삼성전자')) return [{ title: '삼성전자 실적', url: 'https://n/1', source: 'A', publishedAt: t - 600 }, { title: '삼성전자·비트코인 같은 기사', url: 'https://n/dup', source: 'B', publishedAt: t - 3600 }];
      if (q.startsWith('비트코인')) return [{ title: '비트코인 급등', url: 'https://n/2', source: 'C', publishedAt: t - 60 }, { title: '삼성전자·비트코인 같은 기사', url: 'https://n/dup', source: 'B', publishedAt: t - 3600 }, { title: '비트코인 오래된 기사', url: 'https://n/old', source: 'D', publishedAt: t - 10 * 86400 }];
      return [];
    },
  };
  const items = await myNews({ db, news, instruments, now: clock.now });
  expect(items.map((i) => [i.name, i.title])).toEqual([['비트코인', '비트코인 급등'], ['삼성전자', '삼성전자 실적'], ['삼성전자', '삼성전자·비트코인 같은 기사']]);
  expect(items[0]).toMatchObject({ url: 'https://n/2', key: 'coin:BTC-USDT' });
});
