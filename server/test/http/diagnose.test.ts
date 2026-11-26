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
  expect(checks.map((c) => c.id)).toEqual(['okx', 'upbit', 'kis', 'catalog', 'news', 'claude', 'chatgpt', 'storage']);
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
