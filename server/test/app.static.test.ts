import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { buildApp } from '../src/app.js';
import { loginCookie, testDeps } from './helpers.js';

function webDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'web-'));
  writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>앱</title>');
  writeFileSync(path.join(dir, 'app.js'), 'console.log(1)');
  return dir;
}

test('serves index.html for unknown non-api paths', async () => {
  const app = await buildApp({ ...testDeps(), webDist: webDir() });
  const res = await app.inject({ method: 'GET', url: '/some/page' });
  expect(res.statusCode).toBe(200);
  expect(res.body).toContain('<title>앱</title>');
  expect(res.headers['cache-control']).toContain('no-cache');
  const js = await app.inject({ method: 'GET', url: '/app.js' });
  expect(js.body).toBe('console.log(1)');
});

test('api 404 stays JSON (logged in); logged out gets 401 JSON', async () => {
  const app = await buildApp({ ...testDeps(), webDist: webDir() });
  expect((await app.inject({ method: 'GET', url: '/api/nope' })).statusCode).toBe(401);
  const cookie = await loginCookie(app);
  const res = await app.inject({ method: 'GET', url: '/api/nope', headers: { cookie } });
  expect(res.statusCode).toBe(404);
  expect(res.json()).toEqual({ error: '없는 주소입니다' });
});

test('security headers present', async () => {
  const app = await buildApp({ ...testDeps(), webDist: webDir() });
  const res = await app.inject({ method: 'GET', url: '/' });
  const csp = String(res.headers['content-security-policy']);
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("connect-src 'self'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(res.headers['x-content-type-options']).toBe('nosniff');
  expect(res.headers['referrer-policy']).toBe('no-referrer');
});

test('missing web build does not break api', async () => {
  const app = await buildApp({ ...testDeps(), webDist: path.join(os.tmpdir(), 'does-not-exist-xyz') });
  expect((await app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
});

test('missing asset files get 404, not index.html', async () => {
  const app = await buildApp({ ...testDeps(), webDist: webDir() });
  const res = await app.inject({ method: 'GET', url: '/assets/index-old.css' });
  expect(res.statusCode).toBe(404);
  expect(res.body).not.toContain('<title>');
});

test('files added after start (rebuild) are served', async () => {
  const dir = webDir();
  const app = await buildApp({ ...testDeps(), webDist: dir });
  writeFileSync(path.join(dir, 'new-file.js'), 'console.log(2)');
  const res = await app.inject({ method: 'GET', url: '/new-file.js' });
  expect(res.statusCode).toBe(200);
  expect(res.body).toBe('console.log(2)');
  expect(String(res.headers['content-type'])).toContain('javascript');
});
