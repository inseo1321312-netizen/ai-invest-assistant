import { expect, test } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loginCookie, testDeps } from '../helpers.js';

test('alert coins and settings', async () => {
  const app = await buildApp(testDeps());
  expect((await app.inject({ method: 'GET', url: '/api/alerts' })).statusCode).toBe(401);
  const cookie = await loginCookie(app);
  expect((await app.inject({ method: 'GET', url: '/api/alerts', headers: { cookie } })).json()).toEqual({ coins: [], settings: { m5: 2, m15: 3, h1: 5, events: true } });

  expect((await app.inject({ method: 'POST', url: '/api/alerts/coins', headers: { cookie }, payload: { key: 'kr:005930' } })).statusCode).toBe(400);
  expect((await app.inject({ method: 'POST', url: '/api/alerts/coins', headers: { cookie }, payload: { key: 'coin:BTC-USDT' } })).statusCode).toBe(200);
  expect((await app.inject({ method: 'GET', url: '/api/alerts', headers: { cookie } })).json().coins).toEqual(['coin:BTC-USDT']);
  await app.inject({ method: 'DELETE', url: '/api/alerts/coins?key=coin:BTC-USDT', headers: { cookie } });
  expect((await app.inject({ method: 'GET', url: '/api/alerts', headers: { cookie } })).json().coins).toEqual([]);

  for (let i = 0; i < 20; i++) await app.inject({ method: 'POST', url: '/api/alerts/coins', headers: { cookie }, payload: { key: `coin:C${i}-USDT` } });
  const over = await app.inject({ method: 'POST', url: '/api/alerts/coins', headers: { cookie }, payload: { key: 'coin:ZZZ-USDT' } });
  expect(over.statusCode).toBe(400);
  expect(over.json().error).toContain('20개');

  const bad = await app.inject({ method: 'PUT', url: '/api/alerts/settings', headers: { cookie }, payload: { m5: 0.1, m15: 3, h1: 5, events: true } });
  expect(bad.statusCode).toBe(400);
  const ok = await app.inject({ method: 'PUT', url: '/api/alerts/settings', headers: { cookie }, payload: { m5: 1.5, m15: 3, h1: 6, events: false } });
  expect(ok.json()).toEqual({ m5: 1.5, m15: 3, h1: 6, events: false });
});
