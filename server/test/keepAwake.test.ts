import { expect, test } from 'vitest';
import { createKeepAwake } from '../src/keepAwake.js';
import { fakeFetch } from './fakeFetch.js';

test('pings its own public address so the free server does not fall asleep', async () => {
  const f = fakeFetch({ '/api/health': () => ({ ok: true }) });
  await createKeepAwake({ fetch: f, url: 'https://ai-invest-assistant.onrender.com/' })();
  expect(f.calls.map((c) => c.url.href)).toEqual(['https://ai-invest-assistant.onrender.com/api/health']);
});

test('a failed ping is not an error', async () => {
  const boom = (async () => { throw new Error('network down'); }) as unknown as typeof fetch;
  await expect(createKeepAwake({ fetch: boom, url: 'https://x.onrender.com' })()).resolves.toBeUndefined();
});
