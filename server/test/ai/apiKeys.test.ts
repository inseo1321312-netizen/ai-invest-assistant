import { expect, test } from 'vitest';
import { openDb } from '../../src/db.js';
import { checkKeyShape, createApiKeys, verifyKey } from '../../src/ai/apiKeys.js';
import { fakeFetch } from '../fakeFetch.js';

// 비밀값 검사에 걸리지 않게 조각으로 만든 가짜 키
const CLAUDE = 'sk-ant-' + 'a1'.repeat(12) + 'WXYZ';
const OPENAI = 'sk-' + 'proj-' + 'b2'.repeat(12) + 'QRST';
const SECRET = 'x'.repeat(40);

test('a key saved in the app is stored encrypted and read back; only the last 4 characters are shown', () => {
  const db = openDb(':memory:');
  const keys = createApiKeys({ db, secret: SECRET, env: { claude: null, openai: null } });
  expect(keys.info('claude')).toEqual({ set: false, source: null, tail: null });
  keys.set('claude', CLAUDE);
  expect(keys.get('claude')).toBe(CLAUDE);
  expect(keys.info('claude')).toEqual({ set: true, source: 'app', tail: 'WXYZ' });
  expect(JSON.stringify(db.kvGet('secret.apiKey.claude'))).not.toContain(CLAUDE.slice(7, 20));
  // 서버를 다시 켜도(같은 비밀값) 읽힌다
  expect(createApiKeys({ db, secret: SECRET, env: { claude: null, openai: null } }).get('claude')).toBe(CLAUDE);
  // 비밀값이 다르면 못 읽는다
  expect(createApiKeys({ db, secret: 'y'.repeat(40), env: { claude: null, openai: null } }).get('claude')).toBeNull();
});

test('a key from the server settings is used until one is saved in the app; clearing goes back to it', () => {
  const db = openDb(':memory:');
  const keys = createApiKeys({ db, secret: SECRET, env: { claude: null, openai: OPENAI } });
  expect(keys.info('openai')).toEqual({ set: true, source: 'server', tail: 'QRST' });
  const other = OPENAI.slice(0, -4) + 'ABCD';
  keys.set('openai', other);
  expect(keys.get('openai')).toBe(other);
  keys.clear('openai');
  expect(keys.get('openai')).toBe(OPENAI);
});

test('key shapes', () => {
  expect(checkKeyShape('claude', CLAUDE)).toBe(true);
  expect(checkKeyShape('openai', OPENAI)).toBe(true);
  expect(checkKeyShape('claude', OPENAI)).toBe(false);
  expect(checkKeyShape('openai', 'hello')).toBe(false);
  expect(checkKeyShape('claude', CLAUDE + ' extra')).toBe(false);
});

test('keys are checked with the provider before saving', async () => {
  const ok = fakeFetch({ '/v1/models': () => ({ data: [] }) });
  expect(await verifyKey('claude', CLAUDE, ok)).toBe('ok');
  expect(ok.calls[0]!.url.host).toBe('api.anthropic.com');
  expect(await verifyKey('openai', OPENAI, ok)).toBe('ok');
  expect(ok.calls[1]!.url.host).toBe('api.openai.com');
  const bad = fakeFetch({ '/v1/models': () => new Response('{}', { status: 401 }) });
  expect(await verifyKey('claude', CLAUDE, bad)).toBe('bad');
  const down = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
  expect(await verifyKey('openai', OPENAI, down)).toBe('unreachable');
});
