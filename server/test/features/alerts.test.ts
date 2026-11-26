import { describe, expect, test } from 'vitest';
import { openDb } from '../../src/db.js';
import { addAlertCoin, createAlertMonitor, getAlertSettings, isQuietHour } from '../../src/features/alerts.js';
import { listFeed } from '../../src/features/briefing.js';
import type { OkxAnnouncement, OkxTicker } from '../../src/market/okx.js';
import type { NewsItem } from '../../src/market/news.js';
import type { UpbitMarket } from '../../src/market/upbit.js';
import { makeClock } from '../helpers.js';

// 2026-11-26(목) 10:00 KST: 조용한 시간 아님
const KST_10 = Date.UTC(2026, 10, 26, 1, 0);

function setup(opts: { now?: number; coins?: string[] } = {}) {
  const db = openDb(':memory:');
  const clock = makeClock(opts.now ?? KST_10);
  const state = {
    price: 100,
    anns: [] as OkxAnnouncement[],
    markets: [] as UpbitMarket[],
    news: [] as NewsItem[],
    liqs: [] as { side: 'long' | 'short'; usd: number; ts: number }[],
    funding: 0.0001 as number | null,
  };
  const sent: { title: string; body: string }[] = [];
  const okx = {
    async getTickers(instType: 'SPOT' | 'SWAP'): Promise<OkxTicker[]> {
      return instType === 'SPOT' ? [{ instId: 'BTC-USDT', last: state.price, open24h: 100, volCcy24h: 1e9 }] : [{ instId: 'BTC-USDT-SWAP', last: state.price, open24h: 100, volCcy24h: 1e6 }];
    },
    async getAnnouncements() { return state.anns; },
    async getLiquidations() { return state.liqs; },
    async getFundingRate() { return state.funding; },
  };
  const monitor = createAlertMonitor({
    db, now: clock.now, okx,
    upbit: { markets: async () => state.markets },
    news: { search: async () => state.news },
    instruments: { koreanCoinName: (b: string) => (b === 'BTC' ? '비트코인' : null) },
    push: { async sendAll(p: { title: string; body: string; url: string }) { sent.push(p); } },
  });
  for (const k of opts.coins ?? ['coin:BTC-USDT']) addAlertCoin(db, k, clock.now());
  return { db, clock, state, sent, monitor };
}

describe('price alerts', () => {
  test('a 15-minute move past the threshold alerts once, then waits 30 minutes', async () => {
    const { clock, state, sent, monitor, db } = setup();
    for (let i = 0; i <= 15; i++) {
      state.price = 100 + (3.5 * i) / 15;
      await monitor.tickPrices();
      if (i < 15) clock.advance(60_000);
    }
    expect(sent).toHaveLength(1);
    expect(sent[0]!.title).toBe('[급변] 비트코인 15분 +3.5%');
    expect(listFeed(db, '2026-11-26')[0]).toMatchObject({ kind: 'spike', key: 'coin:BTC-USDT', isBreaking: true });
    clock.advance(60_000);
    await monitor.tickPrices();
    expect(sent).toHaveLength(1);
    // 31분 뒤 같은 방향으로 또 크게 움직이면 다시 알린다
    for (let i = 0; i < 31; i++) {
      clock.advance(60_000);
      state.price += 0.25;
      await monitor.tickPrices();
    }
    expect(sent.length).toBeGreaterThanOrEqual(2);
  });

  test('small moves do nothing', async () => {
    const { clock, state, sent, monitor } = setup();
    for (let i = 0; i <= 20; i++) {
      state.price = 100 + i * 0.01;
      await monitor.tickPrices();
      clock.advance(60_000);
    }
    expect(sent).toHaveLength(0);
  });

  test('quiet hours (02:00-06:00 KST) send nothing', async () => {
    const { clock, state, sent, monitor } = setup({ now: Date.UTC(2026, 10, 25, 18, 0) }); // KST 03:00
    for (let i = 0; i <= 15; i++) {
      state.price = 100 + (5 * i) / 15;
      await monitor.tickPrices();
      clock.advance(60_000);
    }
    expect(sent).toHaveLength(0);
  });

  test('no alert coins → no market calls', async () => {
    let calls = 0;
    const db = openDb(':memory:');
    const monitor = createAlertMonitor({
      db, now: () => KST_10,
      okx: { async getTickers() { calls++; return []; }, async getAnnouncements() { calls++; return []; }, async getLiquidations() { calls++; return []; }, async getFundingRate() { calls++; return null; } },
      upbit: { markets: async () => { calls++; return []; } }, news: { search: async () => { calls++; return []; } },
      instruments: { koreanCoinName: () => null }, push: { async sendAll() {} },
    });
    await monitor.tickPrices();
    await monitor.tickEvents();
    expect(calls).toBe(0);
  });
});

describe('event alerts', () => {
  test('the first check only records what already exists; later new announcements about the coin alert', async () => {
    const { state, sent, monitor } = setup();
    state.anns = [
      { type: 'announcements-delistings', title: 'OKX to delist ABC', url: 'https://www.okx.com/help/1', ts: 1 },
      { type: 'announcements-new-listings', title: 'OKX to list BTC options', url: 'https://www.okx.com/help/2', ts: 2 },
    ];
    await monitor.tickEvents();
    expect(sent).toHaveLength(0);
    state.anns = [
      ...state.anns,
      { type: 'announcements-deposit-withdrawal-suspension-resumption', title: 'Suspension of BTC deposits on Lightning', url: 'https://www.okx.com/help/3', ts: 3 },
      { type: 'announcements-delistings', title: 'OKX to delist XYZ', url: 'https://www.okx.com/help/4', ts: 4 },
    ];
    await monitor.tickEvents();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.title).toContain('비트코인');
    expect(sent[0]!.title).toContain('Suspension of BTC deposits');
    await monitor.tickEvents();
    expect(sent).toHaveLength(1);
  });

  test('Upbit warning turning on alerts once', async () => {
    const { state, sent, monitor } = setup();
    state.markets = [{ market: 'KRW-BTC', koreanName: '비트코인', englishName: 'Bitcoin', warning: false, cautions: [] }];
    await monitor.tickEvents();
    state.markets = [{ market: 'KRW-BTC', koreanName: '비트코인', englishName: 'Bitcoin', warning: true, cautions: ['PRICE_FLUCTUATIONS'] }];
    await monitor.tickEvents();
    await monitor.tickEvents();
    const upbit = sent.filter((s) => s.title.includes('업비트'));
    expect(upbit.length).toBe(2); // 유의 지정 1, 주의(가격 급변동) 1
    expect(upbit.some((s) => s.title.includes('가격 급변동'))).toBe(true);
  });

  test('news with a key word alerts once per article', async () => {
    const { state, sent, monitor } = setup();
    await monitor.tickEvents();
    state.news = [
      { title: '비트코인 거래소 해킹 의혹', url: 'https://news.example/1', source: '한경', publishedAt: 1 },
      { title: '비트코인 가격 횡보', url: 'https://news.example/2', source: '한경', publishedAt: 1 },
    ];
    await monitor.tickEvents();
    await monitor.tickEvents();
    const news = sent.filter((s) => s.title.startsWith('[뉴스]'));
    expect(news).toHaveLength(1);
    expect(news[0]!.title).toContain('해킹');
  });

  test('big liquidations in five minutes and extreme funding alert, with repeat limits', async () => {
    const { clock, state, sent, monitor } = setup();
    state.funding = 0.0015;
    state.liqs = [{ side: 'long', usd: 800_000, ts: KST_10 - 60_000 }, { side: 'short', usd: 300_000, ts: KST_10 - 120_000 }, { side: 'long', usd: 5_000_000, ts: KST_10 - 3600_000 }];
    await monitor.tickEvents();
    expect(sent.some((s) => s.title.startsWith('[청산]') && s.title.includes('$1.1M'))).toBe(true);
    expect(sent.some((s) => s.title.startsWith('[펀딩비]'))).toBe(true);
    const before = sent.length;
    clock.advance(5 * 60_000);
    state.liqs = state.liqs.map((l) => ({ ...l, ts: clock.now() - 60_000 }));
    await monitor.tickEvents();
    expect(sent.length).toBe(before);
  });
});

test('settings default and quiet hours', () => {
  expect(getAlertSettings(openDb(':memory:'))).toEqual({ m5: 2, m15: 3, h1: 5, events: true });
  expect(isQuietHour(Date.UTC(2026, 10, 25, 17, 0))).toBe(true); // KST 02:00
  expect(isQuietHour(Date.UTC(2026, 10, 25, 20, 59))).toBe(true); // KST 05:59
  expect(isQuietHour(Date.UTC(2026, 10, 25, 21, 0))).toBe(false); // KST 06:00
});
