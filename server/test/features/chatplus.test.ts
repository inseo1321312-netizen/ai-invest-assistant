import { expect, test } from 'vitest';
import { openDb } from '../../src/db.js';
import { createMarketService } from '../../src/market/service.js';
import { newsQueryFor } from '../../src/market/news.js';
import { parseInstrumentKey } from '../../src/market/types.js';
import { saveHolding } from '../../src/features/holdings.js';
import { myNews } from '../../src/features/myNews.js';
import { chatTurn } from '../../src/features/chat.js';
import { createBudget } from '../../src/ai/budget.js';
import { buildApp } from '../../src/app.js';
import { fakeKis, fakeOkx } from '../market/fakes.js';
import { fakeRunAi } from '../ai/fakeRunAi.js';
import { loginCookie, makeClock, testDeps } from '../helpers.js';

test('news searches add market words so unrelated stories (dramas etc.) stay out', () => {
  expect(newsQueryFor(parseInstrumentKey('kr:005930'), '삼성전자')).toBe('삼성전자 (주가 OR 주식 OR 실적 OR 증시)');
  expect(newsQueryFor(parseInstrumentKey('us:NAS:AAPL'), '애플')).toBe('애플 (주가 OR 주식 OR 실적 OR 증시)');
  expect(newsQueryFor(parseInstrumentKey('coin:MOVE-USDT'), '무브먼트')).toBe('무브먼트 (코인 OR 가상자산 OR 시세)');
  expect(newsQueryFor(parseInstrumentKey('coin:BTC-USDT'), '비트코인')).toBe('비트코인');
});

test('my news drops stories whose title does not mention the stock', async () => {
  const db = openDb(':memory:');
  const clock = makeClock(Date.UTC(2026, 10, 27, 3, 0));
  saveHolding(db, 'kr:005930', { quantity: 1, avgPrice: null }, clock.now());
  const t = clock.now() / 1000;
  const news = {
    async search() {
      return [
        { title: '삼성전자, 4분기 실적 발표', url: 'https://n/1', source: 'A', publishedAt: t - 60 },
        { title: '주말 드라마 시청률 1위', url: 'https://n/2', source: 'B', publishedAt: t - 30 },
      ];
    },
  };
  const items = await myNews({ db, news, instruments: { nameOf: () => '삼성전자' }, now: clock.now });
  expect(items.map((i) => i.title)).toEqual(['삼성전자, 4분기 실적 발표']);
});

test('chat thinking depth sets how hard the AI thinks', async () => {
  const db = openDb(':memory:');
  const clock = makeClock();
  const market = createMarketService({ db, okx: fakeOkx(), kis: fakeKis(), now: clock.now, fx: async () => 1400 });
  const ai = fakeRunAi([[{ text: 'a' }], [{ text: 'b' }]]);
  const deps = { db, market, runAi: ai.runAi, now: clock.now };
  for await (const _ of chatTurn(deps, { chatId: null, key: null, provider: 'gpt', text: '깊게', depth: 'deep' })) { /* 끝까지 */ }
  for await (const _ of chatTurn(deps, { chatId: null, key: null, provider: 'gpt', text: '보통' })) { /* 끝까지 */ }
  expect(ai.requests.map((r) => r.tier)).toEqual(['deep', 'standard']);
});

test('a ChatGPT usage-limit hit remembers how many requests fit in 5 hours', () => {
  const db = openDb(':memory:');
  const clock = makeClock();
  const b = createBudget(db, clock.now);
  for (let i = 0; i < 7; i++) b.record('interactive', 'gpt', 0);
  expect(b.usage().gptCapEstimate).toBeNull();
  b.noteLimitHit('gpt');
  expect(b.usage().gptCapEstimate).toBe(7);
});

test('one conversation can be deleted; ready says which AI can answer', async () => {
  const deps = testDeps();
  const app = await buildApp(deps);
  const cookie = await loginCookie(app);
  const ins = deps.db.sql.prepare('INSERT INTO chats (key, title, created_at) VALUES (NULL, ?, 0)');
  const a = Number(ins.run('첫 대화').lastInsertRowid);
  ins.run('둘째 대화');
  expect((await app.inject({ method: 'DELETE', url: `/api/chats/${a}`, headers: { cookie } })).statusCode).toBe(200);
  const chats = (await app.inject({ method: 'GET', url: '/api/chats', headers: { cookie } })).json().chats;
  expect(chats.map((c: { title: string }) => c.title)).toEqual(['둘째 대화']);

  expect((await app.inject({ method: 'GET', url: '/api/ai/ready', headers: { cookie } })).json()).toEqual({ claude: false, gpt: false, preferred: 'gpt', gptMode: 'siwc' });
  deps.settings.keys.set('claude', 'sk-ant-' + 'a1'.repeat(12) + 'WXYZ');
  expect((await app.inject({ method: 'GET', url: '/api/ai/ready', headers: { cookie } })).json()).toMatchObject({ claude: true, preferred: 'claude' });
});
