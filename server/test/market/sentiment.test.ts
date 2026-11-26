import { expect, test } from 'vitest';
import { createSentiment } from '../../src/market/sentiment.js';

const reply = (value: string) => new Response(JSON.stringify({ data: [{ value, value_classification: 'x', timestamp: '1795000000' }] }));

test('reads the crypto fear and greed index in Korean and caches it for 30 minutes', async () => {
  let calls = 0;
  let now = 1_000_000;
  const s = createSentiment({ fetch: (async () => { calls++; return reply('23'); }) as typeof fetch, now: () => now });
  expect(await s()).toEqual({ value: 23, label: '극도의 공포', updatedAt: 1795000000 });
  await s();
  expect(calls).toBe(1);
  now += 31 * 60_000;
  await s();
  expect(calls).toBe(2);
});

test('labels each band of the index', async () => {
  const label = async (v: string) => (await createSentiment({ fetch: (async () => reply(v)) as typeof fetch, now: () => 0 })())!.label;
  expect(await label('40')).toBe('공포');
  expect(await label('50')).toBe('중립');
  expect(await label('70')).toBe('탐욕');
  expect(await label('90')).toBe('극도의 탐욕');
});

test('gives null when the source fails or sends junk', async () => {
  expect(await createSentiment({ fetch: (async () => { throw new Error('down'); }) as typeof fetch, now: () => 0 })()).toBeNull();
  expect(await createSentiment({ fetch: (async () => new Response('{"data":[]}')) as typeof fetch, now: () => 0 })()).toBeNull();
});
