import { expect, test } from 'vitest';
import { buildApp } from '../src/app.js';
import { testDeps } from './helpers.js';

test('GET /api/health', async () => {
  const app = await buildApp(testDeps());
  const res = await app.inject({ method: 'GET', url: '/api/health' });
  expect(res.statusCode).toBe(200);
  // up: 서버가 켜진 지 몇 초인지(잠들었다 깨면 0부터 다시)
  expect(res.json()).toEqual({ ok: true, up: expect.any(Number) });
});
