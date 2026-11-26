import { expect, test } from 'vitest';
import { buildApp } from '../src/app.js';
import { testDeps } from './helpers.js';

test('GET /api/health', async () => {
  const app = await buildApp(testDeps());
  const res = await app.inject({ method: 'GET', url: '/api/health' });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true });
});
