import { expect, test } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createMarketService } from '../../src/market/service.js';
import { loginCookie, testDeps } from '../helpers.js';
import { fakeKis, fakeOkx } from '../market/fakes.js';

async function setup(over: Parameters<typeof testDeps>[0] = {}, okx = fakeOkx(), kis = fakeKis()) {
  const deps = testDeps(over);
  deps.market = createMarketService({ okx, kis, db: deps.db, now: deps.now, fx: async () => 1400 });
  const app = await buildApp(deps);
  const cookie = await loginCookie(app);
  return { app, cookie, deps };
}

test('diagnose reports each connection with Korean status', async () => {
  const { app, cookie } = await setup({ connected: { kis: true } }, fakeOkx(), fakeKis({ async getQuote() { throw new Error('down'); } }));
  const res = await app.inject({ method: 'GET', url: '/api/admin/diagnose', headers: { cookie } });
  expect(res.statusCode).toBe(200);
  const checks = Object.fromEntries(res.json().checks.map((c: { id: string; state: string; detail: string }) => [c.id, c]));
  expect(checks.okx).toMatchObject({ state: 'ok' });
  expect(checks.okxAccount).toBeUndefined();
  expect(checks.kis).toMatchObject({ state: 'fail' });
  expect(checks.claude).toMatchObject({ state: 'off' });
  expect(checks.chatgpt).toMatchObject({ state: 'off' });
  expect(checks.storage).toMatchObject({ state: 'warn' });
  expect(res.json().checks.every((c: { label: string; detail: string }) => c.label.length > 0 && /[가-힣]/.test(c.detail))).toBe(true);
});

test('diagnose also checks Upbit, the stock lists and news', async () => {
  const instruments = { search: async (q: string) => (q === 'AAPL' ? [{ key: 'us:NAS:AAPL', market: 'us' as const, name: '애플', symbol: 'AAPL' }] : []), nameOf: () => null, koreanCoinName: () => null, findKrCode: () => null, warm: async () => {} };
  const { app, cookie } = await setup({
    instruments,
    upbit: { markets: async () => [{ market: 'KRW-BTC', koreanName: '비트코인', englishName: 'Bitcoin', warning: false, cautions: [] }], krwPrices: async () => new Map() },
    news: { search: async () => { throw new Error('down'); } },
  });
  const checks = (await app.inject({ method: 'GET', url: '/api/admin/diagnose', headers: { cookie } })).json().checks as { id: string; state: string; detail: string }[];
  expect(checks.map((c) => c.id)).toEqual(['okx', 'upbit', 'naver', 'kis', 'catalog', 'news', 'claude', 'chatgpt', 'storage']);
  const by = Object.fromEntries(checks.map((c) => [c.id, c]));
  expect(by.upbit).toMatchObject({ state: 'ok' });
  expect(by.catalog).toMatchObject({ state: 'warn' });
  expect(by.catalog!.detail).toContain('한국');
  expect(by.news).toMatchObject({ state: 'warn' });
  expect(by.chatgpt!.detail).toContain('설정');
});

test('OKX market failure explains the likely region block', async () => {
  const { app, cookie } = await setup({}, fakeOkx({ async getQuote() { throw new Error('403'); } }));
  const checks = (await app.inject({ method: 'GET', url: '/api/admin/diagnose', headers: { cookie } })).json().checks;
  expect(checks.find((c: { id: string }) => c.id === 'okx')).toMatchObject({ state: 'fail' });
  expect(checks.find((c: { id: string }) => c.id === 'okx').detail).toMatch(/지역/);
});

test('diagnose requires login', async () => {
  const { app } = await setup();
  expect((await app.inject({ method: 'GET', url: '/api/admin/diagnose' })).statusCode).toBe(401);
});

test('opening the feed triggers the catch-up job in the background', async () => {
  let runs = 0;
  const { app, cookie } = await setup({ catchUp: async () => { runs++; } });
  await app.inject({ method: 'GET', url: '/api/feed', headers: { cookie } });
  expect(runs).toBe(1);
});

test('stock prices come from Naver without a KIS key; the KIS check tests KIS itself', async () => {
  const naver = {
    async getQuote(inst: { market: string; symbol: string }) { return { instrument: inst, price: inst.market === 'kr' ? 171500 : 355.58, changePct24h: 0, currency: inst.market === 'kr' ? 'KRW' : 'USD', time: 0 }; },
  };
  const noKey = await setup({ naver, connected: { kis: false } } as never);
  const a = Object.fromEntries((await noKey.app.inject({ method: 'GET', url: '/api/admin/diagnose', headers: { cookie: noKey.cookie } })).json().checks.map((c: { id: string }) => [c.id, c]));
  expect(a.naver).toMatchObject({ state: 'ok' });
  expect(a.naver.detail).toContain('삼성전자');
  expect(a.kis).toMatchObject({ state: 'off' });
  expect(a.kis.detail).toContain('네이버');

  // 한투 키가 있지만 한투가 실패하면, 네이버로 넘어가는 시세와 상관없이 실패로 보여야 한다
  const kis = { async getQuote() { throw new Error('kis down'); } };
  const withKey = await setup({ naver, kis, connected: { kis: true } } as never);
  const b = Object.fromEntries((await withKey.app.inject({ method: 'GET', url: '/api/admin/diagnose', headers: { cookie: withKey.cookie } })).json().checks.map((c: { id: string }) => [c.id, c]));
  expect(b.kis).toMatchObject({ state: 'fail' });
});
