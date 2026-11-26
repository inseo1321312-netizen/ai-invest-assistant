import { expect, test } from 'vitest';
import { buildApp } from '../src/app.js';
import { loginCookie, testDeps, TEST_PASSWORD } from './helpers.js';

async function setup() {
  const deps = testDeps();
  const app = await buildApp(deps);
  app.get('/api/_ping', async () => ({ pong: true }));
  return { app, deps };
}

test('rejects wrong password with 401 and Korean message', async () => {
  const { app } = await setup();
  const res = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'wrong-password-1' } });
  expect(res.statusCode).toBe(401);
  expect(res.json()).toEqual({ error: '비밀번호가 틀렸습니다' });
});

test('protected route requires login', async () => {
  const { app } = await setup();
  const res = await app.inject({ method: 'GET', url: '/api/_ping' });
  expect(res.statusCode).toBe(401);
});

test('login sets httpOnly strict cookie and unlocks /api/*', async () => {
  const { app } = await setup();
  const res = await app.inject({ method: 'POST', url: '/api/login', payload: { password: TEST_PASSWORD } });
  expect(res.statusCode).toBe(200);
  const cookie = String(res.headers['set-cookie']);
  expect(cookie).toMatch(/HttpOnly/i);
  expect(cookie).toMatch(/SameSite=Strict/i);
  const sid = cookie.split(';')[0]!;
  const ping = await app.inject({ method: 'GET', url: '/api/_ping', headers: { cookie: sid } });
  expect(ping.statusCode).toBe(200);
  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: sid } });
  expect(me.json()).toEqual({ loggedIn: true });
});

test('/api/me works without login', async () => {
  const { app } = await setup();
  const me = await app.inject({ method: 'GET', url: '/api/me' });
  expect(me.statusCode).toBe(200);
  expect(me.json()).toEqual({ loggedIn: false });
});

test('tampered cookie is rejected', async () => {
  const { app } = await setup();
  const sid = await loginCookie(app);
  const bad = sid.slice(0, -2) + 'xx';
  const ping = await app.inject({ method: 'GET', url: '/api/_ping', headers: { cookie: bad } });
  expect(ping.statusCode).toBe(401);
});

test('expired session is rejected', async () => {
  const { app, deps } = await setup();
  const sid = await loginCookie(app);
  deps.clock.advance(31 * 24 * 3600 * 1000);
  const ping = await app.inject({ method: 'GET', url: '/api/_ping', headers: { cookie: sid } });
  expect(ping.statusCode).toBe(401);
});

test('logout deletes the session', async () => {
  const { app } = await setup();
  const sid = await loginCookie(app);
  await app.inject({ method: 'POST', url: '/api/logout', headers: { cookie: sid } });
  const ping = await app.inject({ method: 'GET', url: '/api/_ping', headers: { cookie: sid } });
  expect(ping.statusCode).toBe(401);
});

test('5 failed logins in 10 minutes → 429 for 10 minutes, even with right password', async () => {
  const { app, deps } = await setup();
  for (let i = 0; i < 5; i++) {
    await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'wrong-password-1' } });
  }
  const blocked = await app.inject({ method: 'POST', url: '/api/login', payload: { password: TEST_PASSWORD } });
  expect(blocked.statusCode).toBe(429);
  deps.clock.advance(11 * 60 * 1000);
  const ok = await app.inject({ method: 'POST', url: '/api/login', payload: { password: TEST_PASSWORD } });
  expect(ok.statusCode).toBe(200);
});

test('percent-encoded or mixed-encoding api paths cannot bypass login', async () => {
  const { app } = await setup();
  for (const url of ['/%61pi/_ping', '/%61%70%69/_ping', '/ap%69/_ping', '/api/%5Fping', '/%61pi/me/../_ping']) {
    const res = await app.inject({ method: 'GET', url });
    expect([401, 404], url).toContain(res.statusCode);
    expect(res.body).not.toContain('pong');
  }
});

test('encoded api path is blocked over a real socket too', async () => {
  const { app } = await setup();
  await app.listen({ port: 0, host: '127.0.0.1' });
  try {
    const port = (app.server.address() as { port: number }).port;
    for (const p of ['/%61pi/_ping', '/%61%70%69/_ping', '/api/_ping']) {
      const res = await fetch(`http://127.0.0.1:${port}${p}`);
      expect([401, 404], p).toContain(res.status);
    }
  } finally {
    await app.close();
  }
});
