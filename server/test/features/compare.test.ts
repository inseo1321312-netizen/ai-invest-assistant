import { describe, expect, test } from 'vitest';
import { openDb } from '../../src/db.js';
import { createMarketService } from '../../src/market/service.js';
import { parseInstrumentKey, type Candle, type Quote } from '../../src/market/types.js';
import { compareHistory, computeFacts, getCompare, runCompare } from '../../src/features/compare.js';
import { fakeKis, fakeOkx } from '../market/fakes.js';
import { fakeRunAi, type FakeStep } from '../ai/fakeRunAi.js';
import { makeClock } from '../helpers.js';

const NOW = Date.UTC(2026, 10, 26, 0, 30); // KST 09:30
const NOW_SEC = NOW / 1000;
const BTC = 'coin:BTC-USDT';
const ETH = 'coin:ETH-USDT';

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const e of it) out.push(e);
  return out;
}

function candles(n: number, step: number): Candle[] {
  const last = Math.floor(NOW_SEC / step) * step - step;
  return Array.from({ length: n }, (_, i) => ({ time: last - (n - 1 - i) * step, open: 100 + i, high: 102 + i, low: 99 + i, close: 101 + i, volume: 10 }));
}

function setup(script: FakeStep[][], fail: (instId: string) => boolean = () => false) {
  const db = openDb(':memory:');
  const clock = makeClock(NOW);
  const okx = fakeOkx({
    async getCandles(instId, bar, limit) {
      if (fail(instId)) throw new Error('down');
      return candles(limit, bar === '1D' ? 86400 : bar === '4H' ? 4 * 3600 : 3600);
    },
    async getQuote(instId) {
      if (fail(instId)) throw new Error('down');
      return { instrument: parseInstrumentKey(`coin:${instId}`), price: instId.startsWith('BTC') ? 96000 : 3200, changePct24h: -2, currency: 'USDT', time: NOW_SEC };
    },
  });
  const market = createMarketService({ okx, kis: fakeKis(), db, now: clock.now, fx: async () => 1400 });
  const ai = fakeRunAi(script);
  return { deps: { db, market, runAi: ai.runAi, now: clock.now }, ai, db, clock };
}

const good = (pick: string | null = ETH): FakeStep => ({ tool: 'submit_comparison', input: {
  pick, confidence: '중간', summary: '이더리움이 추세가 더 낫다.',
  ranking: [
    { key: ETH, rank: 1, opinion: '매수', reason: '20일선 위에서 눌림 후 반등', risk: '거래량이 약하다' },
    { key: BTC, rank: 2, opinion: '관망', reason: '고점 근처', risk: '되돌림 가능' },
  ],
} });

describe('facts', () => {
  test('price position in the year, month change and the 20-day trend come from daily candles', () => {
    const daily: Candle[] = Array.from({ length: 252 }, (_, i) => ({ time: i * 86400, open: 100 + i, high: 100 + i, low: 100 + i, close: 100 + i, volume: 1 }));
    const quote: Quote = { instrument: parseInstrumentKey(BTC), price: 351, changePct24h: 1.5, currency: 'USDT', time: 0 };
    const f = computeFacts(daily, quote);
    expect(f.price).toBe(351);
    expect(f.currency).toBe('USDT');
    expect(f.dayPct).toBe(1.5);
    expect(f.yearPos).toBeCloseTo(100, 5);
    expect(f.monthPct).toBeCloseTo((351 / 330 - 1) * 100, 6);
    expect(f.aboveMa20).toBe(true);
  });

  test('no candles and no quote means nothing is known', () => {
    expect(computeFacts([], null)).toEqual({ price: null, currency: null, dayPct: null, monthPct: null, yearPos: null, aboveMa20: null });
  });
});

describe('runCompare', () => {
  test('ranks every pick and saves it', async () => {
    const s = setup([[good()]]);
    const ev = await collect(runCompare(s.deps, { keys: [BTC, ETH], horizon: 'swing', provider: 'claude' }));
    const done = ev.find((e) => e.type === 'compare') as Extract<(typeof ev)[number], { type: 'compare' }>;
    expect(done.cached).toBe(false);
    expect(done.result).toMatchObject({ pick: ETH, confidence: '중간', keys: [BTC, ETH], horizon: 'swing', provider: 'claude' });
    expect(done.result.ranking.map((r) => r.key)).toEqual([ETH, BTC]);
    expect(done.result.facts[BTC]!.price).toBe(96000);
    expect(done.result.facts[ETH]!.price).toBe(3200);
    expect(ev.some((e) => e.type === 'status')).toBe(true);
    const text = s.ai.requests[0]!.userText;
    expect(text).toContain(BTC);
    expect(text).toContain(ETH);
    expect(getCompare(s.db, done.result.id)?.pick).toBe(ETH);
  });

  test('pick null means wait', async () => {
    const s = setup([[good(null)]]);
    const ev = await collect(runCompare(s.deps, { keys: [BTC, ETH], horizon: 'long', provider: 'gpt' }));
    expect(ev.find((e) => e.type === 'compare')).toMatchObject({ result: { pick: null } });
  });

  test('a ranking that misses an item is refused and asked again once', async () => {
    const half: FakeStep = { tool: 'submit_comparison', input: { pick: ETH, confidence: '높음', summary: 'x', ranking: [{ key: ETH, rank: 1, opinion: '매수', reason: 'a', risk: 'b' }] } };
    const s = setup([[half], [good()]]);
    const ev = await collect(runCompare(s.deps, { keys: [BTC, ETH], horizon: 'swing', provider: 'claude' }));
    expect(s.ai.calls()).toBe(2);
    expect(ev.find((e) => e.type === 'compare')).toBeTruthy();
  });

  test('a pick outside the list or a made-up opinion is refused too; two bad answers end in an error', async () => {
    const outside: FakeStep = { tool: 'submit_comparison', input: { ...(good() as { input: object }).input, pick: 'coin:SOL-USDT' } };
    const s = setup([[outside], [outside]]);
    const ev = await collect(runCompare(s.deps, { keys: [BTC, ETH], horizon: 'swing', provider: 'claude' }));
    expect(ev.find((e) => e.type === 'compare')).toBeUndefined();
    expect(ev.at(-1)).toMatchObject({ type: 'error' });
  });

  test('one chart failing still compares the rest; all failing is an error', async () => {
    const s = setup([[good()]], (id) => id.startsWith('ETH'));
    const ev = await collect(runCompare(s.deps, { keys: [BTC, ETH], horizon: 'swing', provider: 'claude' }));
    const done = ev.find((e) => e.type === 'compare') as Extract<(typeof ev)[number], { type: 'compare' }>;
    expect(done.result.facts[ETH]).toBeNull();
    expect(done.result.facts[BTC]!.price).toBe(96000);

    const all = setup([[good()]], () => true);
    const ev2 = await collect(runCompare(all.deps, { keys: [BTC, ETH], horizon: 'swing', provider: 'claude' }));
    expect(ev2.at(-1)).toMatchObject({ type: 'error', message: '비교할 데이터를 가져오지 못했습니다' });
    expect(all.ai.calls()).toBe(0);
  });

  test('the same set within 10 minutes is served from storage, in any order', async () => {
    const s = setup([[good()], [good()], [good()]]);
    await collect(runCompare(s.deps, { keys: [BTC, ETH], horizon: 'swing', provider: 'claude' }));
    s.clock.advance(9 * 60_000);
    const again = await collect(runCompare(s.deps, { keys: [ETH, BTC], horizon: 'swing', provider: 'claude' }));
    expect(again.find((e) => e.type === 'compare')).toMatchObject({ cached: true });
    expect(s.ai.calls()).toBe(1);
    const other = await collect(runCompare(s.deps, { keys: [BTC, ETH], horizon: 'long', provider: 'claude' }));
    expect(other.find((e) => e.type === 'compare')).toMatchObject({ cached: false });
    s.clock.advance(11 * 60_000);
    const later = await collect(runCompare(s.deps, { keys: [BTC, ETH], horizon: 'swing', provider: 'claude' }));
    expect(later.find((e) => e.type === 'compare')).toMatchObject({ cached: false });
    expect(s.ai.calls()).toBe(3);
  });

  test('history is newest first, at most 10', async () => {
    const s = setup(Array.from({ length: 12 }, () => [good()]));
    for (let i = 0; i < 12; i++) {
      await collect(runCompare(s.deps, { keys: [BTC, ETH], horizon: 'swing', provider: 'claude' }));
      s.clock.advance(11 * 60_000);
    }
    const h = compareHistory(s.db);
    expect(h).toHaveLength(10);
    expect(h[0]!.createdAt).toBeGreaterThan(h[1]!.createdAt);
    expect(h[0]).toMatchObject({ keys: [BTC, ETH], horizon: 'swing', provider: 'claude', pick: ETH });
  });
});

describe('compare routes', () => {
  async function app() {
    const { buildApp } = await import('../../src/app.js');
    const { loginCookie, testDeps } = await import('../helpers.js');
    const deps = testDeps();
    const a = await buildApp(deps);
    return { a, deps, cookie: await loginCookie(a) };
  }

  test('one item, five items or the same item twice is a bad request', async () => {
    const { a, cookie } = await app();
    for (const keys of [[BTC], [BTC, ETH, 'coin:SOL-USDT', 'coin:XRP-USDT', 'coin:DOGE-USDT'], [BTC, BTC]]) {
      const r = await a.inject({ method: 'POST', url: '/api/compare', headers: { cookie }, payload: { keys, horizon: 'swing', provider: 'claude' } });
      expect(r.statusCode).toBe(400);
    }
  });

  test('quick picks: holdings first, then favorites, each once', async () => {
    const { a, deps, cookie } = await app();
    deps.db.sql.prepare('INSERT INTO holdings (key, market, quantity, avg_price, added_at) VALUES (?, ?, ?, ?, ?)').run('kr:005930', 'kr', 10, null, 1);
    deps.db.sql.prepare('INSERT INTO watchlist (key, market, added_at) VALUES (?, ?, ?)').run('kr:005930', 'kr', 2);
    deps.db.sql.prepare('INSERT INTO watchlist (key, market, added_at) VALUES (?, ?, ?)').run(BTC, 'coin', 3);
    const r = await a.inject({ method: 'GET', url: '/api/compare/suggest', headers: { cookie } });
    expect(r.json().items.map((i: { key: string; source: string }) => [i.key, i.source])).toEqual([['kr:005930', 'holding'], [BTC, 'favorite']]);
  });

  test('history and one result; a missing one is 404', async () => {
    const { a, deps, cookie } = await app();
    deps.db.sql.prepare('INSERT INTO comparisons (set_key, keys_json, horizon, provider, model, body_json, facts_json, names_json, created_at, cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('x', JSON.stringify([BTC, ETH]), 'swing', 'gpt', 'm', JSON.stringify({ pick: BTC, confidence: '중간', summary: 's', ranking: [] }), '{}', '{}', 5, 0);
    const h = (await a.inject({ method: 'GET', url: '/api/compare/history', headers: { cookie } })).json().items;
    expect(h).toHaveLength(1);
    const one = await a.inject({ method: 'GET', url: `/api/compare/${h[0].id}`, headers: { cookie } });
    expect(one.json().result).toMatchObject({ pick: BTC, keys: [BTC, ETH] });
    expect((await a.inject({ method: 'GET', url: '/api/compare/999', headers: { cookie } })).statusCode).toBe(404);
  });
});
