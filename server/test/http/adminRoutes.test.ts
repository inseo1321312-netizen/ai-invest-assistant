import { expect, test } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loginCookie, testDeps } from '../helpers.js';

const payload = {
  clientId: 'oaiapp_abc', accessToken: 'SECRET-AT', refreshToken: 'SECRET-RT', idToken: null,
  expiresAt: Date.now() + 3600_000, scopes: ['openid', 'chatgpt.tokens.use.direct'],
};

test('siwc token upload requires login', async () => {
  const app = await buildApp(testDeps());
  const res = await app.inject({ method: 'POST', url: '/api/admin/siwc-tokens', payload });
  expect(res.statusCode).toBe(401);
});

test('upload, status never returns token values, delete', async () => {
  const deps = testDeps();
  const app = await buildApp(deps);
  const cookie = await loginCookie(app);
  const up = await app.inject({ method: 'POST', url: '/api/admin/siwc-tokens', headers: { cookie }, payload });
  expect(up.statusCode).toBe(200);
  const status = await app.inject({ method: 'GET', url: '/api/admin/siwc-status', headers: { cookie } });
  expect(status.json()).toEqual({ connected: true, expiresAt: payload.expiresAt });
  expect(status.body).not.toContain('SECRET');
  await app.inject({ method: 'DELETE', url: '/api/admin/siwc-tokens', headers: { cookie } });
  expect((await app.inject({ method: 'GET', url: '/api/admin/siwc-status', headers: { cookie } })).json()).toEqual({ connected: false, expiresAt: null });
});

test('invalid upload → 400', async () => {
  const app = await buildApp(testDeps());
  const cookie = await loginCookie(app);
  const res = await app.inject({ method: 'POST', url: '/api/admin/siwc-tokens', headers: { cookie }, payload: { ...payload, scopes: ['openid'] } });
  expect(res.statusCode).toBe(400);
});

test('host id endpoint returns stable id', async () => {
  const app = await buildApp(testDeps());
  const cookie = await loginCookie(app);
  const a = (await app.inject({ method: 'GET', url: '/api/admin/siwc-host-id', headers: { cookie } })).json();
  const b = (await app.inject({ method: 'GET', url: '/api/admin/siwc-host-id', headers: { cookie } })).json();
  expect(a.hostId).toMatch(/^urn:uuid:/);
  expect(a).toEqual(b);
});

test('issued client id is remembered for later sign-ins, even after disconnect', async () => {
  const app = await buildApp(testDeps());
  const cookie = await loginCookie(app);
  expect((await app.inject({ method: 'GET', url: '/api/admin/siwc-host-id', headers: { cookie } })).json().clientId).toBeNull();
  await app.inject({ method: 'POST', url: '/api/admin/siwc-tokens', headers: { cookie }, payload });
  await app.inject({ method: 'DELETE', url: '/api/admin/siwc-tokens', headers: { cookie } });
  expect((await app.inject({ method: 'GET', url: '/api/admin/siwc-host-id', headers: { cookie } })).json().clientId).toBe('oaiapp_abc');
});
