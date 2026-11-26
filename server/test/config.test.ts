import { expect, test } from 'vitest';
import { loadConfig } from '../src/config.js';

const base = { APP_PASSWORD: 'p'.repeat(12), SESSION_SECRET: 's'.repeat(32) };

test('requires APP_PASSWORD of 12+ chars', () => {
  expect(() => loadConfig({ SESSION_SECRET: 'x'.repeat(32), APP_PASSWORD: 'short' })).toThrow(/APP_PASSWORD/);
});

test('requires SESSION_SECRET of 32+ chars', () => {
  expect(() => loadConfig({ APP_PASSWORD: 'p'.repeat(12), SESSION_SECRET: 'short' })).toThrow(/SESSION_SECRET/);
});

test('okx is null unless all three values are set', () => {
  expect(loadConfig({ ...base, OKX_API_KEY: 'k' }).okx).toBeNull();
  expect(loadConfig({ ...base, OKX_API_KEY: 'k', OKX_API_SECRET: 's', OKX_API_PASSPHRASE: 'p' }).okx)
    .toEqual({ key: 'k', secret: 's', passphrase: 'p' });
});

test('kis needs all four values', () => {
  expect(loadConfig({ ...base, KIS_APP_KEY: 'a', KIS_APP_SECRET: 'b', KIS_ACCOUNT_NO: '12345678' }).kis).toBeNull();
  expect(loadConfig({ ...base, KIS_APP_KEY: 'a', KIS_APP_SECRET: 'b', KIS_ACCOUNT_NO: '12345678', KIS_ACCOUNT_PRODUCT: '01' }).kis)
    .toEqual({ appKey: 'a', appSecret: 'b', accountNo: '12345678', productCode: '01' });
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
