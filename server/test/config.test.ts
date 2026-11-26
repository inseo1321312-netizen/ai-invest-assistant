import { expect, test } from 'vitest';
import { loadConfig } from '../src/config.js';

const base = { APP_PASSWORD: 'p'.repeat(12), SESSION_SECRET: 's'.repeat(32) };

test('requires APP_PASSWORD of 12+ chars', () => {
  expect(() => loadConfig({ SESSION_SECRET: 'x'.repeat(32), APP_PASSWORD: 'short' })).toThrow(/APP_PASSWORD/);
});

test('requires SESSION_SECRET of 32+ chars', () => {
  expect(() => loadConfig({ APP_PASSWORD: 'p'.repeat(12), SESSION_SECRET: 'short' })).toThrow(/SESSION_SECRET/);
});

test('OKX keys are no longer part of the config', () => {
  expect('okx' in loadConfig({ ...base, OKX_API_KEY: 'k', OKX_API_SECRET: 's', OKX_API_PASSPHRASE: 'p' })).toBe(false);
});

test('kis needs only app key and secret', () => {
  expect(loadConfig({ ...base, KIS_APP_KEY: 'a' }).kis).toBeNull();
  expect(loadConfig({ ...base, KIS_APP_KEY: 'a', KIS_APP_SECRET: 'b' }).kis).toEqual({ appKey: 'a', appSecret: 'b' });
});

test('defaults port 8080 and dataDir /data', () => {
  const c = loadConfig(base);
  expect(c.port).toBe(8080);
  expect(c.dataDir).toBe('/data');
  expect(c.anthropicApiKey).toBeNull();
  expect(c.vapid).toBeNull();
});

test('empty strings count as unset', () => {
  expect(loadConfig({ ...base, ANTHROPIC_API_KEY: '' }).anthropicApiKey).toBeNull();
});

test('DATABASE_URL is optional', () => {
  expect(loadConfig(base).databaseUrl).toBeNull();
  expect(loadConfig({ ...base, DATABASE_URL: 'postgresql://u:p@h/db?sslmode=require' }).databaseUrl).toBe('postgresql://u:p@h/db?sslmode=require');
});

test('public URL comes from PUBLIC_URL or Render', () => {
  expect(loadConfig(base).publicUrl).toBeNull();
  expect(loadConfig({ ...base, RENDER_EXTERNAL_URL: 'https://x.onrender.com' }).publicUrl).toBe('https://x.onrender.com');
});
