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
