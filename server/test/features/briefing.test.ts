import { describe, expect, test } from 'vitest';
import { openDb } from '../../src/db.js';
import { createMarketService } from '../../src/market/service.js';
import { parseInstrumentKey, type Holding } from '../../src/market/types.js';
import { checkSpikesAndLiquidation, isMarketOpen, listFeed, runMorningBriefing } from '../../src/features/briefing.js';
import { latestAnalyses } from '../../src/features/analysis.js';
import { createPush } from '../../src/push.js';
import { startScheduler } from '../../src/scheduler.js';
import { fakeKis, fakeOkx } from '../market/fakes.js';
import { fakeRunAi, type FakeStep } from '../ai/fakeRunAi.js';
import { makeClock } from '../helpers.js';

const h = (key: string, extra: Partial<Holding> = {}): Holding => ({
  instrument: parseInstrumentKey(key), quantity: 1, avgPrice: 100, currency: key.startsWith('kr') ? 'KRW' : key.startsWith('us') ? 'USD' : 'USDT',
  source: 'okx', side: null, leverage: null, liqPrice: null, markPrice: null, unrealizedPnl: null, fundingRate: null, ...extra,
});

// 2026-11-26(목) KST 10:00 → 한국장 열림, 미국장 닫힘
const KST_10 = Date.UTC(2026, 10, 26, 1, 0);

function setup(opts: { coin?: Holding[]; kr?: Holding[]; us?: Holding[]; change?: Record<string, number>; script?: FakeStep[][]; now?: number }) {
  const db = openDb(':memory:');
  const clock = makeClock(opts.now ?? KST_10);
  const change = opts.change ?? {};
  const okx = fakeOkx({
    async getHoldings() { return opts.coin ?? []; },
    async getQuote(instId) { return { instrument: parseInstrumentKey(`coin:${instId}`), price: 100, changePct24h: change[`coin:${instId}`] ?? 0, currency: 'USDT', time: 0 }; },
  });
  const kis = fakeKis({
    async getHoldings() { return [...(opts.kr ?? []), ...(opts.us ?? [])]; },
    async getQuote(inst) { const k = inst.market === 'kr' ? `kr:${inst.symbol}` : `us:${inst.exchange}:${inst.symbol}`; return { instrument: inst, price: 100, changePct24h: change[k] ?? 0, currency: inst.market === 'kr' ? 'KRW' : 'USD', time: 0 }; },
  });
  const market = createMarketService({ okx, kis, db, now: clock.now, fx: async () => 1400 });
  const ai = fakeRunAi(opts.script ?? []);
  const sent: { title: string; body: string }[] = [];
  const push = { subscribe() {}, async sendAll(p: { title: string; body: string; url: string }) { sent.push(p); } };
  return { deps: { db, market, runAi: ai.runAi, now: clock.now, push }, ai, sent, clock, db };
}

const briefingSubmit = (items: { key: string; isBreaking: boolean; opinion: string }[]): FakeStep => ({
  tool: 'submit_briefing',
  input: {
    summary: '오늘 요약',
    items: items.map((i) => ({ key: i.key, headline: `${i.key} 소식`, detail: '자세히', isBreaking: i.isBreaking, opinion: i.opinion, confidence: '중간', reasons: ['근거'], risks: ['위험'] })),
  },
});

describe('morning briefing', () => {
  test('one AI call per tab with holdings, none for empty tabs', async () => {
    const { deps, ai } = setup({
      coin: [h('coin:BTC-USDT')], kr: [h('kr:005930', { source: 'kis' })],
      script: [[briefingSubmit([{ key: 'coin:BTC-USDT', isBreaking: false, opinion: '유지' }])], [briefingSubmit([{ key: 'kr:005930', isBreaking: false, opinion: '유지' }])]],
    });
    await runMorningBriefing(deps);
    expect(ai.calls()).toBe(2);
    expect(ai.requests.every((r) => r.purpose === 'scheduled' && r.provider === 'claude')).toBe(true);
    expect(ai.requests[0]!.webSearch).toEqual({ maxUses: 5 });
    const feed = listFeed(deps.db, '2026-11-26');
    expect(feed.filter((f) => f.kind === 'briefing').map((f) => f.market)).toEqual(['kr', 'coin']);
  });

  test('breaking items create feed entries and trigger push', async () => {
    const { deps, sent } = setup({
      coin: [h('coin:BTC-USDT'), h('coin:ETH-USDT')],
      script: [[briefingSubmit([{ key: 'coin:BTC-USDT', isBreaking: true, opinion: '유지' }, { key: 'coin:ETH-USDT', isBreaking: false, opinion: '유지' }])]],
    });
    await runMorningBriefing(deps);
    const feed = listFeed(deps.db, '2026-11-26');
    expect(feed[0]).toMatchObject({ kind: 'breaking', isBreaking: true, key: 'coin:BTC-USDT', title: 'coin:BTC-USDT 소식' });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.title).toBe('[속보] coin:BTC-USDT 소식');
  });

  test('no breaking → no push', async () => {
    const { deps, sent } = setup({ coin: [h('coin:BTC-USDT')], script: [[briefingSubmit([{ key: 'coin:BTC-USDT', isBreaking: false, opinion: '유지' }])]] });
    await runMorningBriefing(deps);
    expect(sent).toHaveLength(0);
  });

  test('briefing opinions saved as swing analyses (badge source); invalid opinion skipped', async () => {
    const { deps } = setup({
      coin: [h('coin:BTC-USDT'), h('coin:ETH-USDT')],
      script: [[briefingSubmit([{ key: 'coin:BTC-USDT', isBreaking: false, opinion: '일부 매도' }, { key: 'coin:ETH-USDT', isBreaking: false, opinion: '롱 진입' }])]],
    });
    await runMorningBriefing(deps);
    expect(latestAnalyses(deps.db, 'coin:BTC-USDT', 'swing')[0]).toMatchObject({ opinion: '일부 매도', provider: 'claude', reasons: ['근거'] });
    expect(latestAnalyses(deps.db, 'coin:ETH-USDT', 'swing')).toEqual([]);
  });

  test('AI error in one tab does not stop others', async () => {
    const { deps } = setup({ coin: [h('coin:BTC-USDT')], kr: [h('kr:005930')], script: [[], [briefingSubmit([{ key: 'coin:BTC-USDT', isBreaking: false, opinion: '유지' }])]] });
    await runMorningBriefing(deps);
    expect(listFeed(deps.db, '2026-11-26').filter((f) => f.kind === 'briefing').map((f) => f.market)).toEqual(['coin']);
  });
});

describe('spikes and liquidation', () => {
  test('dedupes repeated spike alerts', async () => {
    const { deps, sent, clock, ai } = setup({ coin: [h('coin:SOL-USDT')], change: { 'coin:SOL-USDT': 6.1 }, script: [[{ text: '상장 소식' }], [{ text: '또' }]] });
    await checkSpikesAndLiquidation(deps);
    clock.advance(3600_000);
    await checkSpikesAndLiquidation(deps);
    expect(sent).toHaveLength(1);
    expect(ai.calls()).toBe(1);
    expect(ai.requests[0]).toMatchObject({ tier: 'light', purpose: 'scheduled', webSearch: { maxUses: 2 } });
    const spike = listFeed(deps.db, '2026-11-26').find((f) => f.kind === 'spike')!;
    expect(spike).toMatchObject({ isBreaking: true, body: '상장 소식' });
    expect(spike.title).toContain('+6.1%');
  });

  test('opposite direction spike same day alerts again', async () => {
    const change: Record<string, number> = { 'coin:SOL-USDT': 6 };
    const { deps, sent } = setup({ coin: [h('coin:SOL-USDT')], change, script: [[{ text: 'a' }], [{ text: 'b' }]] });
    await checkSpikesAndLiquidation(deps);
    change['coin:SOL-USDT'] = -7;
    // 시세 캐시(10초)를 넘기려고 시간 이동
    (deps as { now: () => number }).now = (() => { const t = KST_10 + 60_000; return () => t; })();
    await checkSpikesAndLiquidation({ ...deps, market: createMarketService({ okx: fakeOkx({ async getHoldings() { return [h('coin:SOL-USDT')]; }, async getQuote(id) { return { instrument: parseInstrumentKey(`coin:${id}`), price: 100, changePct24h: -7, currency: 'USDT', time: 0 }; } }), kis: fakeKis(), db: deps.db, now: deps.now, fx: async () => 1 }) });
    expect(sent).toHaveLength(2);
  });

  test('kr stocks skipped outside 09:00-15:30 KST and on weekends', () => {
    expect(isMarketOpen('kr', Date.UTC(2026, 10, 26, 1, 0))).toBe(true); // 목 10:00
    expect(isMarketOpen('kr', Date.UTC(2026, 10, 26, 6, 31))).toBe(false); // 목 15:31
    expect(isMarketOpen('kr', Date.UTC(2026, 10, 28, 1, 0))).toBe(false); // 토
    expect(isMarketOpen('coin', Date.UTC(2026, 10, 28, 1, 0))).toBe(true);
  });

  test('us market hours follow America/New_York incl. DST', () => {
    expect(isMarketOpen('us', Date.UTC(2026, 10, 26, 15, 0))).toBe(true); // 11월(EST) 10:00 ET = 15:00 UTC
    expect(isMarketOpen('us', Date.UTC(2026, 10, 26, 14, 0))).toBe(false); // 09:00 ET
    expect(isMarketOpen('us', Date.UTC(2026, 6, 15, 14, 0))).toBe(true); // 7월(EDT) 10:00 ET = 14:00 UTC
  });

  test('kr holdings not checked when market closed', async () => {
    const { deps, sent } = setup({ kr: [h('kr:005930')], change: { 'kr:005930': 9 }, now: Date.UTC(2026, 10, 28, 1, 0), script: [[{ text: 'x' }]] });
    await checkSpikesAndLiquidation(deps);
    expect(sent).toHaveLength(0);
  });

  test('liquidation proximity alert at 5% without AI call, max once per 6h', async () => {
    const pos = h('coin:BTC-USDT-SWAP', { side: 'long', leverage: 20, liqPrice: 96, markPrice: 100 });
    const { deps, sent, ai, clock } = setup({ coin: [pos] });
    await checkSpikesAndLiquidation(deps);
    expect(ai.calls()).toBe(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.title).toContain('청산');
    clock.advance(5 * 3600_000);
    await checkSpikesAndLiquidation(deps);
    expect(sent).toHaveLength(1);
    clock.advance(2 * 3600_000);
    await checkSpikesAndLiquidation(deps);
    expect(sent).toHaveLength(2);
  });
});

describe('push and scheduler', () => {
  test('push removes subscriptions on 410 and sends to the rest', async () => {
    const db = openDb(':memory:');
    const delivered: string[] = [];
    const push = createPush({
      vapid: { publicKey: 'pub', privateKey: 'priv', subject: 'mailto:me@example.com' }, db,
      send: async (sub) => { if (sub.endpoint.includes('gone')) throw Object.assign(new Error('gone'), { statusCode: 410 }); delivered.push(sub.endpoint); return {} as never; },
    });
    push.subscribe({ endpoint: 'https://push/a', keys: { p256dh: 'p', auth: 'a' } });
    push.subscribe({ endpoint: 'https://push/gone', keys: { p256dh: 'p', auth: 'a' } });
    await push.sendAll({ title: 't', body: 'b', url: '/' });
    expect(delivered).toEqual(['https://push/a']);
    expect((db.sql.prepare('SELECT COUNT(*) AS n FROM push_subs').get() as { n: number }).n).toBe(1);
  });

  test('push without vapid does nothing', async () => {
    let called = false;
    const push = createPush({ vapid: null, db: openDb(':memory:'), send: async () => { called = true; return {} as never; } });
    push.subscribe({ endpoint: 'https://push/a', keys: { p256dh: 'p', auth: 'a' } });
    await push.sendAll({ title: 't', body: 'b', url: '/' });
    expect(called).toBe(false);
  });

  test('scheduler registers 08:00 and hourly :05 jobs in Asia/Seoul', () => {
    const jobs: { pattern: string; opts: Record<string, unknown> }[] = [];
    const s = startScheduler(
      { briefing: async () => {}, spikes: async () => {} },
      (pattern, opts) => { jobs.push({ pattern, opts }); return { stop() {} }; },
    );
    expect(jobs.map((j) => j.pattern)).toEqual(['0 8 * * *', '5 * * * *']);
    expect(jobs.every((j) => j.opts.timezone === 'Asia/Seoul' && j.opts.protect === true)).toBe(true);
    s.stop();
  });
});
