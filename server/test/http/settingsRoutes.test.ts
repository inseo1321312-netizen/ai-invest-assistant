import { expect, test } from 'vitest';
import { buildApp } from '../../src/app.js';
import { DEFAULT_MODELS } from '../../src/ai/router.js';
import { DEFAULT_LIMITS } from '../../src/ai/budget.js';
import { loginCookie, testDeps } from '../helpers.js';

test('get settings returns models, gpt mode, budget and no secrets', async () => {
  const deps = testDeps();
  const app = await buildApp(deps);
  const cookie = await loginCookie(app);
  const res = await app.inject({ method: 'GET', url: '/api/settings', headers: { cookie } });
  expect(res.json()).toEqual({
    models: DEFAULT_MODELS, gptMode: 'siwc', budget: DEFAULT_LIMITS,
    keys: { claude: false, openai: false, kis: false, push: false },
    apiKeys: { claude: { set: false, source: null, tail: null }, openai: { set: false, source: null, tail: null } },
  });
  expect(res.body).not.toMatch(/sk-|secret/i);
});

test('settings PUT validates and rejects unknown keys', async () => {
  const deps = testDeps();
  const app = await buildApp(deps);
  const cookie = await loginCookie(app);
  const bad = await app.inject({ method: 'PUT', url: '/api/settings', headers: { cookie }, payload: { anthropicApiKey: 'x' } });
  expect(bad.statusCode).toBe(400);
  const neg = await app.inject({ method: 'PUT', url: '/api/settings', headers: { cookie }, payload: { budget: { ...DEFAULT_LIMITS, monthlyUsd: -1 } } });
  expect(neg.statusCode).toBe(400);
  const ok = await app.inject({ method: 'PUT', url: '/api/settings', headers: { cookie }, payload: { gptMode: 'apikey', budget: { ...DEFAULT_LIMITS, monthlyUsd: 50 } } });
  expect(ok.statusCode).toBe(200);
  const after = (await app.inject({ method: 'GET', url: '/api/settings', headers: { cookie } })).json();
  expect(after.gptMode).toBe('apikey');
  expect(after.budget.monthlyUsd).toBe(50);
});

test('usage endpoint', async () => {
  const deps = testDeps();
  const app = await buildApp(deps);
  const cookie = await loginCookie(app);
  deps.settings.budget.record('interactive', 'claude', 0.42);
  const res = (await app.inject({ method: 'GET', url: '/api/usage', headers: { cookie } })).json();
  expect(res.today.interactive).toBeCloseTo(0.42, 6);
  expect(res.limits).toEqual(DEFAULT_LIMITS);
});

const CLAUDE = 'sk-ant-' + 'a1'.repeat(12) + 'WXYZ';
const OPENAI = 'sk-' + 'proj-' + 'b2'.repeat(12) + 'QRST';

test('a Claude API key typed in the app is checked, saved, and never sent back', async () => {
  const checked: string[] = [];
  const deps = testDeps();
  deps.settings.verifyKey = async (p) => { checked.push(p); return 'ok'; };
  const app = await buildApp(deps);
  const cookie = await loginCookie(app);
  const res = await app.inject({ method: 'PUT', url: '/api/settings/api-key', headers: { cookie }, payload: { provider: 'claude', key: CLAUDE } });
  expect(res.statusCode).toBe(200);
  expect(res.json().apiKeys.claude).toEqual({ set: true, source: 'app', tail: 'WXYZ' });
  expect(res.json().keys.claude).toBe(true);
  expect(res.body).not.toContain(CLAUDE);
  expect(checked).toEqual(['claude']);
  expect(deps.settings.keys.get('claude')).toBe(CLAUDE);
});

test('a wrong or malformed key is refused and nothing is saved', async () => {
  const deps = testDeps();
  let calls = 0;
  deps.settings.verifyKey = async () => { calls += 1; return 'bad'; };
  const app = await buildApp(deps);
  const cookie = await loginCookie(app);
  const shape = await app.inject({ method: 'PUT', url: '/api/settings/api-key', headers: { cookie }, payload: { provider: 'claude', key: 'hello' } });
  expect(shape.statusCode).toBe(400);
  expect(calls).toBe(0);
  const bad = await app.inject({ method: 'PUT', url: '/api/settings/api-key', headers: { cookie }, payload: { provider: 'claude', key: CLAUDE } });
  expect(bad.statusCode).toBe(400);
  expect(bad.json().error).toMatch(/키가 맞지 않아요/);
  expect(deps.settings.keys.get('claude')).toBeNull();
  deps.settings.verifyKey = async () => 'unreachable';
  expect((await app.inject({ method: 'PUT', url: '/api/settings/api-key', headers: { cookie }, payload: { provider: 'claude', key: CLAUDE } })).statusCode).toBe(502);
});

test('a ChatGPT API key switches GPT to the API; removing it switches back to the subscription', async () => {
  const deps = testDeps();
  deps.settings.verifyKey = async () => 'ok';
  const app = await buildApp(deps);
  const cookie = await loginCookie(app);
  const put = await app.inject({ method: 'PUT', url: '/api/settings/api-key', headers: { cookie }, payload: { provider: 'openai', key: OPENAI } });
  expect(put.json()).toMatchObject({ gptMode: 'apikey', apiKeys: { openai: { set: true, tail: 'QRST' } } });
  const del = await app.inject({ method: 'DELETE', url: '/api/settings/api-key?provider=openai', headers: { cookie } });
  expect(del.json()).toMatchObject({ gptMode: 'siwc', apiKeys: { openai: { set: false } }, keys: { openai: false } });
});
