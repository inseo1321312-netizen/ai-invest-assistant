import { describe, expect, test } from 'vitest';
import { openDb } from '../../src/db.js';
import { createMarketService } from '../../src/market/service.js';
import { parseInstrumentKey } from '../../src/market/types.js';
import { isMarketOpen, listFeed, runMorningBriefing } from '../../src/features/briefing.js';
import { latestAnalyses } from '../../src/features/analysis.js';
import { createPush } from '../../src/push.js';
import { startScheduler } from '../../src/scheduler.js';
import { fakeKis, fakeOkx } from '../market/fakes.js';
import { fakeRunAi, type FakeStep } from '../ai/fakeRunAi.js';
import { makeClock } from '../helpers.js';

// 2026-11-26(목) KST 10:00 → 한국장 열림, 미국장 닫힘
const KST_10 = Date.UTC(2026, 10, 26, 1, 0);

function setup(opts: { coin?: string[]; kr?: string[]; us?: string[]; change?: Record<string, number>; script?: FakeStep[][]; now?: number }) {
  const db = openDb(':memory:');
  const clock = makeClock(opts.now ?? KST_10);
  const change = opts.change ?? {};
  const okx = fakeOkx({
    async getQuote(instId) { return { instrument: parseInstrumentKey(`coin:${instId}`), price: 100, changePct24h: change[`coin:${instId}`] ?? 0, currency: 'USDT', time: 0 }; },
  });
  const kis = fakeKis({
    async getQuote(inst) { const k = inst.market === 'kr' ? `kr:${inst.symbol}` : `us:${inst.exchange}:${inst.symbol}`; return { instrument: inst, price: 100, changePct24h: change[k] ?? 0, currency: inst.market === 'kr' ? 'KRW' : 'USD', time: 0 }; },
  });
  const market = createMarketService({ okx, kis, db, now: clock.now, fx: async () => 1400 });
  for (const k of [...(opts.coin ?? []), ...(opts.kr ?? []), ...(opts.us ?? [])]) market.addWatch(k);
  const ai = fakeRunAi(opts.script ?? []);
  const sent: { title: string; body: string }[] = [];
  const push = { subscribe() {}, publicKey: () => 'test-key', async sendAll(p: { title: string; body: string; url: string }) { sent.push(p); } };
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
  test('one AI call per tab with favorites, none for empty tabs', async () => {
    const { deps, ai } = setup({
      coin: ['coin:BTC-USDT'], kr: ['kr:005930'],
      script: [[briefingSubmit([{ key: 'coin:BTC-USDT', isBreaking: false, opinion: '관망' }])], [briefingSubmit([{ key: 'kr:005930', isBreaking: false, opinion: '관망' }])]],
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
      coin: ['coin:BTC-USDT', 'coin:ETH-USDT'],
      script: [[briefingSubmit([{ key: 'coin:BTC-USDT', isBreaking: true, opinion: '관망' }, { key: 'coin:ETH-USDT', isBreaking: false, opinion: '관망' }])]],
    });
    await runMorningBriefing(deps);
    const feed = listFeed(deps.db, '2026-11-26');
    expect(feed[0]).toMatchObject({ kind: 'breaking', isBreaking: true, key: 'coin:BTC-USDT', title: 'coin:BTC-USDT 소식' });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.title).toBe('[속보] coin:BTC-USDT 소식');
  });

  test('no breaking → no push', async () => {
    const { deps, sent } = setup({ coin: ['coin:BTC-USDT'], script: [[briefingSubmit([{ key: 'coin:BTC-USDT', isBreaking: false, opinion: '관망' }])]] });
    await runMorningBriefing(deps);
    expect(sent).toHaveLength(0);
  });

  test('briefing opinions saved as swing analyses (badge source); invalid opinion skipped', async () => {
    const { deps } = setup({
      coin: ['coin:BTC-USDT', 'coin:ETH-USDT'],
      script: [[briefingSubmit([{ key: 'coin:BTC-USDT', isBreaking: false, opinion: '매도' }, { key: 'coin:ETH-USDT', isBreaking: false, opinion: '롱 진입' }])]],
    });
    await runMorningBriefing(deps);
    expect(latestAnalyses(deps.db, 'coin:BTC-USDT', 'swing')[0]).toMatchObject({ opinion: '매도', provider: 'claude', reasons: ['근거'] });
    expect(latestAnalyses(deps.db, 'coin:ETH-USDT', 'swing')).toEqual([]);
  });

  test('runs on trending items alone when there are no favorites, and asks for the week calendar', async () => {
    const { deps, ai } = setup({ script: [[briefingSubmit([{ key: 'coin:SOL-USDT', isBreaking: false, opinion: '관망' }])]] });
    const trending = { get: async (m: string) => (m === 'coin' ? [{ key: 'coin:SOL-USDT', name: '솔라나', symbol: 'SOL', price: 200, changePct: 12.3, value: 1, currency: 'USDT' as const }] : []) };
    await runMorningBriefing({ ...deps, trending });
    expect(ai.calls()).toBe(1);
    expect(ai.requests[0]!.userText).toContain('지금 뜨는 종목');
    expect(ai.requests[0]!.userText).toContain('솔라나');
    expect(ai.requests[0]!.instructions).toContain('이번 주 일정');
  });

  test('no favorites and nothing trending → no AI call', async () => {
    const { deps, ai } = setup({});
    await runMorningBriefing({ ...deps, trending: { get: async () => [] } });
    expect(ai.calls()).toBe(0);
  });

  test('AI error in one tab does not stop others', async () => {
    const { deps } = setup({ coin: ['coin:BTC-USDT'], kr: ['kr:005930'], script: [[], [briefingSubmit([{ key: 'coin:BTC-USDT', isBreaking: false, opinion: '관망' }])]] });
    await runMorningBriefing(deps);
    expect(listFeed(deps.db, '2026-11-26').filter((f) => f.kind === 'briefing').map((f) => f.market)).toEqual(['coin']);
  });
});

describe('market hours', () => {
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


  test('scheduler registers the alert checks in Asia/Seoul (no 08:00 briefing)', () => {
    const jobs: { pattern: string; opts: Record<string, unknown> }[] = [];
    const s = startScheduler(
      { alertPrices: async () => {}, alertEvents: async () => {} },
      (pattern, opts) => { jobs.push({ pattern, opts }); return { stop() {} }; },
    );
    expect(jobs.map((j) => j.pattern)).toEqual(['* * * * *', '*/5 * * * *']); // 8시 브리핑은 밤사이 정리가 대신한다
    expect(jobs.every((j) => j.opts.timezone === 'Asia/Seoul' && j.opts.protect === true)).toBe(true);
    s.stop();
  });

  test('with a keep-awake ping it runs every 10 minutes except 02:00–05:59 KST', () => {
    const jobs: string[] = [];
    startScheduler(
      { alertPrices: async () => {}, alertEvents: async () => {}, keepAwake: async () => {} },
      (pattern) => { jobs.push(pattern); return { stop() {} }; },
    );
    expect(jobs).toContain('*/10 0-1,6-23 * * *');
    expect(jobs).toHaveLength(3);
  });
});
