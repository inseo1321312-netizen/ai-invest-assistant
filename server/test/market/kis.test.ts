import { describe, expect, test } from 'vitest';
import { openDb } from '../../src/db.js';
import { assertReadPath, createKisClient, KIS_READ_PATHS, KisBlockedError } from '../../src/market/kis.js';
import { parseInstrumentKey } from '../../src/market/types.js';
import { fakeFetch, type FakeHandler } from '../fakeFetch.js';

const creds = { appKey: 'APPKEY', appSecret: 'APPSECRET' };
const NOW = Date.parse('2026-11-26T09:00:00+09:00');
const samsung = parseInstrumentKey('kr:005930');
const apple = parseInstrumentKey('us:NAS:AAPL');

function tokenHandler(expired = '2026-11-27 09:00:00'): FakeHandler {
  return () => ({ access_token: 'TOKEN-1', access_token_token_expired: expired, token_type: 'Bearer' });
}

function baseRoutes(extra: Record<string, FakeHandler> = {}) {
  return fakeFetch({
    '/oauth2/tokenP': tokenHandler(),
    '/uapi/domestic-stock/v1/quotations/inquire-price': () => ({ rt_cd: '0', output: { stck_prpr: '70500', prdy_ctrt: '-1.25' } }),
    ...extra,
  });
}

function client(f: typeof fetch, db = openDb(':memory:'), now = () => NOW) {
  return createKisClient({ creds, db, fetchImpl: f, now, minIntervalMs: 0 });
}

describe('token', () => {
  test('reuses persisted token across client instances', async () => {
    const db = openDb(':memory:');
    const f = baseRoutes();
    await client(f, db).getQuote(samsung);
    await client(f, db).getQuote(samsung);
    expect(f.count('/oauth2/tokenP')).toBe(1);
  });

  test('concurrent calls issue token once', async () => {
    const f = baseRoutes();
    const c = client(f);
    await Promise.all([c.getQuote(samsung), c.getQuote(samsung), c.getQuote(samsung)]);
    expect(f.count('/oauth2/tokenP')).toBe(1);
  });

  test('refreshes token 10 minutes before expiry', async () => {
    const db = openDb(':memory:');
    let t = NOW;
    const f = baseRoutes();
    await client(f, db, () => t).getQuote(samsung);
    t = Date.parse('2026-11-27T08:49:00+09:00'); // 만료 11분 전 → 재사용
    await client(f, db, () => t).getQuote(samsung);
    expect(f.count('/oauth2/tokenP')).toBe(1);
    t = Date.parse('2026-11-27T08:51:00+09:00'); // 만료 9분 전 → 새로 발급
    await client(f, db, () => t).getQuote(samsung);
    expect(f.count('/oauth2/tokenP')).toBe(2);
  });

  test('token request body uses client_credentials', async () => {
    const f = baseRoutes();
    await client(f).getQuote(samsung);
    const call = f.calls.find((c) => c.url.pathname === '/oauth2/tokenP')!;
    expect(JSON.parse(String(call.init?.body))).toEqual({ grant_type: 'client_credentials', appkey: 'APPKEY', appsecret: 'APPSECRET' });
  });
});

describe('allowlist', () => {
  test('blocks paths outside KIS_READ_PATHS', () => {
    expect(() => assertReadPath('/uapi/domestic-stock/v1/trading/order-cash')).toThrow(KisBlockedError);
    expect(() => assertReadPath('/uapi/overseas-stock/v1/trading/order')).toThrow(KisBlockedError);
  });
  test('KIS_READ_PATHS contains no order or account path', () => {
    for (const p of KIS_READ_PATHS) expect(p).not.toMatch(/order|balance/);
  });
  test('balance paths are not allowed', () => {
    expect(() => assertReadPath('/uapi/domestic-stock/v1/trading/inquire-balance')).toThrow(KisBlockedError);
    expect(() => assertReadPath('/uapi/overseas-stock/v1/trading/inquire-balance')).toThrow(KisBlockedError);
  });
});

describe('quotes and candles', () => {
  test('sends required headers', async () => {
    const f = baseRoutes();
    await client(f).getQuote(samsung);
    const call = f.calls.find((c) => c.url.pathname.endsWith('/inquire-price'))!;
    const h = new Headers(call.init?.headers);
    expect(h.get('authorization')).toBe('Bearer TOKEN-1');
    expect(h.get('appkey')).toBe('APPKEY');
    expect(h.get('tr_id')).toBe('FHKST01010100');
    expect(h.get('custtype')).toBe('P');
    expect(call.url.searchParams.get('FID_INPUT_ISCD')).toBe('005930');
  });

  test('domestic quote in KRW', async () => {
    const q = await client(baseRoutes()).getQuote(samsung);
    expect(q).toMatchObject({ price: 70500, changePct24h: -1.25, currency: 'KRW' });
  });

  test('overseas quote in USD', async () => {
    const f = baseRoutes({
      '/uapi/overseas-price/v1/quotations/price': (url) => {
        expect(url.searchParams.get('EXCD')).toBe('NAS');
        expect(url.searchParams.get('SYMB')).toBe('AAPL');
        return { rt_cd: '0', output: { last: '231.50', rate: '+0.87' } };
      },
    });
    const q = await client(f).getQuote(apple);
    expect(q).toMatchObject({ price: 231.5, changePct24h: 0.87, currency: 'USD' });
  });

  test('domestic daily candles oldest-first with KST-midnight times', async () => {
    const f = baseRoutes({
      '/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice': (url) => {
        expect(url.searchParams.get('FID_PERIOD_DIV_CODE')).toBe('D');
        return {
          rt_cd: '0',
          output2: [
            { stck_bsop_date: '20261126', stck_oprc: '70000', stck_hgpr: '71000', stck_lwpr: '69500', stck_clpr: '70500', acml_vol: '1000' },
            { stck_bsop_date: '20261125', stck_oprc: '69000', stck_hgpr: '70200', stck_lwpr: '68800', stck_clpr: '70000', acml_vol: '900' },
          ],
        };
      },
    });
    const c = await client(f).getCandles(samsung, '1D', 2);
    expect(c.map((x) => x.time)).toEqual([Date.parse('2026-11-25T00:00:00+09:00') / 1000, Date.parse('2026-11-26T00:00:00+09:00') / 1000]);
    expect(c[1]).toMatchObject({ open: 70000, high: 71000, low: 69500, close: 70500, volume: 1000 });
  });

  test('rt_cd error throws with message', async () => {
    const f = baseRoutes({ '/uapi/domestic-stock/v1/quotations/inquire-price': () => ({ rt_cd: '1', msg1: '조회 오류' }) });
    await expect(client(f).getQuote(samsung)).rejects.toThrow(/조회 오류/);
  });
});

