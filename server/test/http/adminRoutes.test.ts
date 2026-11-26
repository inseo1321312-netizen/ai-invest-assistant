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

type ExchangeArgs = { clientId: string; code: string; verifier: string; redirectUri: string };
const fakeExchange = (calls: ExchangeArgs[]) => async (p: ExchangeArgs) => {
  calls.push(p);
  return { clientId: p.clientId, accessToken: 'AT', refreshToken: 'RT', idToken: null, expiresAt: Date.now() + 3600_000, scopes: ['openid', 'chatgpt.tokens.use.direct'] };
};

test('phone sign-in: start gives the OpenAI address, pasting the callback address connects', async () => {
  const calls: ExchangeArgs[] = [];
  const deps = testDeps({ siwcExchange: fakeExchange(calls) });
  const app = await buildApp(deps);
  const cookie = await loginCookie(app);
  const start = (await app.inject({ method: 'POST', url: '/api/admin/siwc-login/start', headers: { cookie } })).json();
  const u = new URL(start.url);
  expect(`${u.origin}${u.pathname}`).toBe('https://auth.openai.com/api/accounts/authorize');
  expect(u.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:1455/auth/callback');
  const state = u.searchParams.get('state');
  // 사파리가 https로 바꿔도 받아 준다
  const pasted = `https://127.0.0.1:1455/auth/callback?code=CODE1&state=${state}&client_id=oaiapp_new`;
  const fin = await app.inject({ method: 'POST', url: '/api/admin/siwc-login/finish', headers: { cookie }, payload: { url: pasted } });
  expect(fin.json()).toEqual({ ok: true });
  expect(calls[0]).toMatchObject({ clientId: 'oaiapp_new', code: 'CODE1', redirectUri: 'http://127.0.0.1:1455/auth/callback' });
  expect(calls[0]!.verifier.length).toBeGreaterThan(20);
  expect((await app.inject({ method: 'GET', url: '/api/admin/siwc-status', headers: { cookie } })).json().connected).toBe(true);
  const again = await app.inject({ method: 'POST', url: '/api/admin/siwc-login/finish', headers: { cookie }, payload: { url: pasted } });
  expect(again.statusCode).toBe(400);
});

test('phone sign-in refuses wrong, cancelled, incomplete or stale addresses', async () => {
  const calls: ExchangeArgs[] = [];
  const deps = testDeps({ siwcExchange: fakeExchange(calls) });
  const app = await buildApp(deps);
  const cookie = await loginCookie(app);
  const finish = async (url: string) => (await app.inject({ method: 'POST', url: '/api/admin/siwc-login/finish', headers: { cookie }, payload: { url } })).json().error as string;
  expect(await finish('http://127.0.0.1:1455/auth/callback?code=X&state=Y')).toContain('처음부터');
  const start = (await app.inject({ method: 'POST', url: '/api/admin/siwc-login/start', headers: { cookie } })).json();
  const state = new URL(start.url).searchParams.get('state');
  expect(await finish(`http://127.0.0.1:1455/auth/callback?code=X&state=WRONG&client_id=c`)).toContain('처음부터');
  expect(await finish(`http://127.0.0.1:1455/auth/callback?error=access_denied&state=${state}`)).toContain('취소');
  expect(await finish(`http://127.0.0.1:1455/auth/callback?state=${state}&client_id=c`)).toContain('코드가 없어요');
  expect(await finish('아무 글자')).toContain('주소');
  deps.clock.advance(11 * 60_000);
  expect(await finish(`http://127.0.0.1:1455/auth/callback?code=X&state=${state}&client_id=c`)).toContain('시간이 지나서');
  expect(calls).toHaveLength(0);
  expect((await app.inject({ method: 'GET', url: '/api/admin/siwc-status', headers: { cookie } })).json().connected).toBe(false);
});

test('phone sign-in only accepts the 127.0.0.1 callback address', async () => {
  const calls: ExchangeArgs[] = [];
  const app = await buildApp(testDeps({ siwcExchange: fakeExchange(calls) }));
  const cookie = await loginCookie(app);
  const start = (await app.inject({ method: 'POST', url: '/api/admin/siwc-login/start', headers: { cookie } })).json();
  const state = new URL(start.url).searchParams.get('state');
  const res = await app.inject({ method: 'POST', url: '/api/admin/siwc-login/finish', headers: { cookie }, payload: { url: `https://evil.example/auth/callback?code=X&state=${state}&client_id=c` } });
  expect(res.statusCode).toBe(400);
  expect(res.json().error).toContain('주소');
  expect(calls).toHaveLength(0);
});
