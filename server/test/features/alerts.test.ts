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

type Over = { db?: ReturnType<typeof openDb>; clock?: ReturnType<typeof makeClock>; koName?: (b: string) => string | null; explain?: (key: string, name: string, pct: number, w: string) => Promise<string | null>; search?: (q: string) => Promise<NewsItem[]> };

function setup(opts: { now?: number; coins?: string[] } & Over = {}) {
  const db = opts.db ?? openDb(':memory:');
  const clock = opts.clock ?? makeClock(opts.now ?? KST_10);
  const state = {
    price: 100,
    anns: [] as OkxAnnouncement[],
    markets: [] as UpbitMarket[],
    news: [] as NewsItem[],
    liqs: [] as { side: 'long' | 'short'; usd: number; ts: number }[],
    funding: 0.0001 as number | null,
  };
  const sent: { title: string; body: string; url: string }[] = [];
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
    news: { search: opts.search ?? (async () => state.news) },
    instruments: { koreanCoinName: opts.koName ?? ((b: string) => (b === 'BTC' ? '비트코인' : null)) },
    push: { async sendAll(p: { title: string; body: string; url: string }) { sent.push(p); } },
    explain: opts.explain,
    explainWaitMs: 50,
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
      { type: 'announcements-delistings', title: 'OKX to delist ABC', url: 'https://www.okx.com/help/1', ts: KST_10 - 60_000 },
      { type: 'announcements-new-listings', title: 'OKX to list BTC options', url: 'https://www.okx.com/help/2', ts: KST_10 - 60_000 },
    ];
    await monitor.tickEvents();
    expect(sent).toHaveLength(0);
    state.anns = [
      ...state.anns,
      { type: 'announcements-deposit-withdrawal-suspension-resumption', title: 'Suspension of BTC deposits on Lightning', url: 'https://www.okx.com/help/3', ts: KST_10 },
      { type: 'announcements-delistings', title: 'OKX to delist XYZ', url: 'https://www.okx.com/help/4', ts: KST_10 },
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
      { title: '비트코인 거래소 해킹 의혹', url: 'https://news.example/1', source: '한경', publishedAt: KST_10 / 1000 - 600 },
      { title: '비트코인 가격 횡보', url: 'https://news.example/2', source: '한경', publishedAt: KST_10 / 1000 - 600 },
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

describe('review fixes', () => {
  const article = (n: number, title: string, minutesAgo = 5) => ({ title, url: `https://news.example/${n}`, source: '한경', publishedAt: Math.floor(KST_10 / 1000) - minutesAgo * 60 });

  test('a restarted server does not push what piled up while it slept', async () => {
    const a = setup();
    a.state.anns = [{ type: 'announcements-delistings', title: 'OKX to delist ABC', url: 'https://www.okx.com/help/1', ts: KST_10 - 60_000 }];
    await a.monitor.tickEvents();
    // 밤사이 새 공지·기사가 쌓였다
    a.clock.advance(4 * 3600_000);
    a.state.anns = [...a.state.anns, { type: 'announcements-delistings', title: 'Suspension of BTC deposits', url: 'https://www.okx.com/help/9', ts: a.clock.now() - 3600_000 }];
    a.state.news = [article(1, '비트코인 해킹 의혹', 60)];
    const b = setup({ db: a.db, clock: a.clock });
    b.state.anns = a.state.anns;
    b.state.news = a.state.news;
    await b.monitor.tickEvents();
    expect(b.sent).toHaveLength(0);
    b.state.anns = [...b.state.anns, { type: 'announcements-delistings', title: 'BTC withdrawals paused', url: 'https://www.okx.com/help/10', ts: b.clock.now() }];
    await b.monitor.tickEvents();
    expect(b.sent.map((x) => x.title)).toEqual(['[공지] 비트코인: BTC withdrawals paused']);
  });

  test('when the news search words change (names load later) old articles are not pushed', async () => {
    let names = false;
    const t = setup({ koName: (b) => (names && b === 'BTC' ? '비트코인' : null), search: async (q) => (q === '비트코인' ? [article(1, '비트코인 규제 강화'), article(2, '비트코인 소송')] : []) });
    await t.monitor.tickEvents();
    names = true;
    await t.monitor.tickEvents();
    expect(t.sent).toHaveLength(0);
  });

  test('news pushes are limited to one per coin every 2 hours, recent articles only, and open the article', async () => {
    const t = setup();
    await t.monitor.tickEvents();
    t.state.news = [article(1, '비트코인 규제 강화'), article(2, '비트코인 소송 제기'), article(3, '비트코인 해킹', 600)];
    await t.monitor.tickEvents();
    const news = () => t.sent.filter((x) => x.title.startsWith('[뉴스]'));
    expect(news()).toHaveLength(1);
    expect(news()[0]!.url).toBe('https://news.example/1');
    t.clock.advance(60 * 60_000);
    t.state.news = [...t.state.news, { ...article(4, '비트코인 긴급 점검'), publishedAt: Math.floor(t.clock.now() / 1000) }];
    await t.monitor.tickEvents();
    expect(news()).toHaveLength(1);
    t.clock.advance(61 * 60_000);
    t.state.news = [...t.state.news, { ...article(5, '비트코인 ETF 승인'), publishedAt: Math.floor(t.clock.now() / 1000) }];
    await t.monitor.tickEvents();
    expect(news()).toHaveLength(2);
  });

  test('pairs and lowercase words do not match a coin in announcements', async () => {
    const t = setup({ coins: ['coin:BTC-USDT', 'coin:ONE-USDT'] });
    await t.monitor.tickEvents();
    t.state.anns = [
      { type: 'announcements-delistings', title: 'OKX to delist ABC/BTC and XYZ/BTC pairs', url: 'https://www.okx.com/help/20', ts: KST_10 },
      { type: 'announcements-new-listings', title: 'OKX to list one new token', url: 'https://www.okx.com/help/21', ts: KST_10 },
      { type: 'announcements-delistings', title: 'OKX to delist BTC margin pairs in some regions', url: 'https://www.okx.com/help/22', ts: KST_10 },
    ];
    await t.monitor.tickEvents();
    expect(t.sent.map((x) => x.url)).toEqual(['https://www.okx.com/help/22']);
  });

  test('a fall right after a rise still alerts', async () => {
    const t = setup({ explain: undefined });
    // 45분 동안 100, 그다음 15분에 110까지: 오름 알림
    for (let m = 0; m <= 60; m++) {
      t.state.price = m < 45 ? 100 : 100 + (10 * (m - 45)) / 15;
      await t.monitor.tickPrices();
      if (m < 60) t.clock.advance(60_000);
    }
    expect(t.sent.length).toBeGreaterThanOrEqual(1);
    expect(t.sent.every((x) => x.title.includes('+'))).toBe(true);
    // 이어서 15분 동안 110→106: 1시간 창은 아직 "오름"(+6%, 방금 알림)이지만, 15분 창의 하락은 알려야 한다
    for (let m = 1; m <= 15; m++) {
      t.clock.advance(60_000);
      t.state.price = 110 - (4 * m) / 15;
      await t.monitor.tickPrices();
    }
    expect(t.sent.some((x) => x.title.startsWith('[급변] 비트코인 15분 -'))).toBe(true);
  });

  test('the push does not wait for a slow AI explanation; the feed gets it later', async () => {
    let resolve!: (v: string) => void;
    const t = setup({ explain: () => new Promise((r) => { resolve = r; }) });
    for (let i = 0; i <= 15; i++) { t.state.price = 100 + (3.5 * i) / 15; await t.monitor.tickPrices(); if (i < 15) t.clock.advance(60_000); }
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]!.body).not.toContain('상장');
    resolve('거래소 상장 소식');
    await new Promise((r) => setTimeout(r, 10));
    expect(listFeed(t.db, '2026-11-26')[0]!.body).toContain('거래소 상장 소식');
  });

  test('quiet hours do not use up the day\'s funding alert', async () => {
    const t = setup({ now: Date.UTC(2026, 10, 25, 18, 0) }); // KST 03:00
    t.state.funding = 0.002;
    await t.monitor.tickEvents();
    expect(t.sent).toHaveLength(0);
    t.clock.set(Date.UTC(2026, 10, 25, 22, 0)); // KST 07:00 같은 날
    await t.monitor.tickEvents();
    expect(t.sent.some((x) => x.title.startsWith('[펀딩비]'))).toBe(true);
  });

  test('old seen events and alert logs are pruned', async () => {
    const t = setup();
    t.db.sql.prepare('INSERT INTO seen_events (id, seen_at) VALUES (?, ?)').run('old', KST_10 - 40 * 86400_000);
    t.db.sql.prepare('INSERT INTO alert_log (key, kind, direction, sent_at) VALUES (?, ?, ?, ?)').run('coin:BTC-USDT', 'spike', 'up', KST_10 - 5 * 86400_000);
    await t.monitor.tickEvents();
    expect(t.db.sql.prepare("SELECT COUNT(*) AS n FROM seen_events WHERE id = 'old'").get()).toEqual({ n: 0 });
    expect(t.db.sql.prepare('SELECT COUNT(*) AS n FROM alert_log WHERE sent_at < ?').get(KST_10 - 4 * 86400_000)).toEqual({ n: 0 });
  });
});
