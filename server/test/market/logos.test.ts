import { expect, test } from 'vitest';
import { createLogos } from '../../src/market/logos.js';
import { fakeFetch } from '../fakeFetch.js';

const png = (bytes = 10) => new Response(new Uint8Array(bytes).fill(1), { status: 200, headers: { 'content-type': 'image/png' } });
const notFound = () => new Response('nope', { status: 404, headers: { 'content-type': 'text/html' } });

function make(routes: Parameters<typeof fakeFetch>[0]) {
  const f = fakeFetch(routes);
  const logos = createLogos({ fetch: f, usCode: async (inst) => (inst.symbol === 'AAPL' ? 'AAPL.O' : inst.symbol), now: () => 0 });
  return { f, logos };
}

test('Korean and US stocks use Naver logos (US by Naver code)', async () => {
  const { f, logos } = make({
    '/imgstock/fn/real/logo/png/stock/Stock005930.png': () => png(5),
    '/imgstock/fn/real/logo/png/stock/StockAAPL.O.png': () => png(6),
  });
  expect((await logos.get('kr:005930'))?.body.length).toBe(5);
  expect((await logos.get('us:NAS:AAPL'))?.type).toBe('image/png');
  expect(f.calls.map((c) => c.url.host)).toEqual(['ssl.pstatic.net', 'ssl.pstatic.net']);
});

test('coins try Upbit first, then OKX; spot and futures share one logo', async () => {
  const { f, logos } = make({
    '/logos/SSV.png': () => notFound(),
    '/cdn/oksupport/asset/currency/icon/ssv.png': () => png(7),
  });
  expect((await logos.get('coin:SSV-USDT-SWAP'))?.body.length).toBe(7);
  expect((await logos.get('coin:SSV-USDT'))?.body.length).toBe(7);
  expect(f.calls).toHaveLength(2); // 두 번째는 기억해 둔 것을 쓴다
});

test('missing logos and non-images give null and are remembered', async () => {
  const { f, logos } = make({
    '/imgstock/fn/real/logo/png/stock/Stock999999.png': () => notFound(),
    '/logos/XYZ.png': () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    '/cdn/oksupport/asset/currency/icon/xyz.png': () => notFound(),
  });
  expect(await logos.get('kr:999999')).toBeNull();
  expect(await logos.get('kr:999999')).toBeNull();
  expect(await logos.get('coin:XYZ-USDT')).toBeNull();
  expect(f.count('/imgstock/fn/real/logo/png/stock/Stock999999.png')).toBe(1);
});

test('bad keys and oversized images give null', async () => {
  const { logos } = make({ '/imgstock/fn/real/logo/png/stock/Stock005930.png': () => png(600_000) });
  expect(await logos.get('nope')).toBeNull();
  expect(await logos.get('kr:005930')).toBeNull();
});
