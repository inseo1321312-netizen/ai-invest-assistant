import { expect, test } from 'vitest';
import { buildApp } from '../../src/app.js';
import { addFeedItem } from '../../src/features/briefing.js';
import { loginCookie, testDeps } from '../helpers.js';

test('feed lists breaking first then newest, defaults to today KST', async () => {
  const deps = testDeps();
  const app = await buildApp(deps);
  const cookie = await loginCookie(app);
  addFeedItem(deps.db, deps.now, { kind: 'briefing', market: 'coin', key: null, title: '코인 아침 브리핑', body: 'b', isBreaking: false });
  deps.clock.advance(1000);
  addFeedItem(deps.db, deps.now, { kind: 'breaking', market: 'coin', key: 'coin:BTC-USDT', title: '속보', body: 'b', isBreaking: true });
  deps.clock.advance(1000);
  addFeedItem(deps.db, deps.now, { kind: 'spike', market: 'coin', key: 'coin:SOL-USDT', title: '급등', body: 'b', isBreaking: true });
  const res = await app.inject({ method: 'GET', url: '/api/feed', headers: { cookie } });
  expect(res.json().items.map((i: { title: string }) => i.title)).toEqual(['급등', '속보', '코인 아침 브리핑']);
  const other = await app.inject({ method: 'GET', url: '/api/feed?day=2026-01-01', headers: { cookie } });
  expect(other.json().items).toEqual([]);
});

test('push subscribe validates and public key endpoint', async () => {
  const deps = testDeps();
  const app = await buildApp(deps);
  const cookie = await loginCookie(app);
  expect((await app.inject({ method: 'GET', url: '/api/push/public-key', headers: { cookie } })).json()).toEqual({ publicKey: null });
  const bad = await app.inject({ method: 'POST', url: '/api/push/subscribe', headers: { cookie }, payload: { endpoint: 'x' } });
  expect(bad.statusCode).toBe(400);
  const ok = await app.inject({ method: 'POST', url: '/api/push/subscribe', headers: { cookie }, payload: { endpoint: 'https://push.example/1', keys: { p256dh: 'p', auth: 'a' } } });
  expect(ok.statusCode).toBe(200);
});

test('manual briefing run starts in background', async () => {
  const deps = testDeps();
  let ran = 0;
  deps.runBriefing = async () => { ran++; };
  const app = await buildApp(deps);
  const cookie = await loginCookie(app);
  const res = await app.inject({ method: 'POST', url: '/api/admin/run-briefing', headers: { cookie } });
  expect(res.statusCode).toBe(202);
  await new Promise((r) => setTimeout(r, 5));
  expect(ran).toBe(1);
});
