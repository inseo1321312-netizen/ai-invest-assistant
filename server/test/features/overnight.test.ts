import { describe, expect, test } from 'vitest';
import { openDb } from '../../src/db.js';
import type { MarketService } from '../../src/market/service.js';
import { parseInstrumentKey, type Candle, type Instrument, type Quote } from '../../src/market/types.js';
import type { NewsItem } from '../../src/market/news.js';
import { createOvernight, DEFAULT_SETTINGS, latestOvernight, overnightHistory, overnightWindow, readSettings, runOvernight, saveSettings } from '../../src/features/overnight.js';
import { fakeRunAi, type FakeStep } from '../ai/fakeRunAi.js';

const KST = (s: string) => Date.parse(`${s}+09:00`);
const NOW = KST('2026-11-28T07:00:00');
const BTC = 'coin:BTC-USDT';
const AAPL = 'us:NAS:AAPL';
const SS = 'kr:005930';
const NAMES: Record<string, string> = { [BTC]: '비트코인', [AAPL]: '애플', [SS]: '삼성전자' };

describe('window and settings', () => {
  test('from last night at bedtime to this morning at wake time', () => {
    const w = overnightWindow(DEFAULT_SETTINGS, KST('2026-11-28T08:00:00'));
    expect(w).toEqual({ from: KST('2026-11-27T23:00:00'), to: KST('2026-11-28T07:00:00'), day: '2026-11-28' });
  });

  test('a bedtime after midnight is the same morning, not the night before', () => {
    const w = overnightWindow({ ...DEFAULT_SETTINGS, sleep: '01:00' }, KST('2026-11-28T08:00:00'));
    expect(w.from).toBe(KST('2026-11-28T01:00:00'));
  });

  test('settings are kept, and times outside the allowed range or not on the half hour are refused', () => {
    const db = openDb(':memory:');
    expect(readSettings(db)).toEqual({ sleep: '23:00', wake: '07:00', notify: true });
    for (const bad of [{ wake: '05:00' }, { wake: '07:15' }, { wake: '11:30' }, { sleep: '20:00' }, { sleep: '02:30' }]) {
      expect(() => saveSettings(db, { ...DEFAULT_SETTINGS, ...bad })).toThrow();
    }
    expect(saveSettings(db, { sleep: '00:30', wake: '06:30', notify: false })).toEqual({ sleep: '00:30', wake: '06:30', notify: false });
    expect(readSettings(db)).toEqual({ sleep: '00:30', wake: '06:30', notify: false });
  });
});

function hourly(fromMs: number, n: number, start: number, step: number): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const o = start + i * step;
    return { time: fromMs / 1000 + i * 3600, open: o, high: o + 300, low: o - 500, close: o + step, volume: 1 };
  });
}

function setup(script: FakeStep[][], opts: { holdings?: string[]; favorites?: string[]; news?: (q: string) => NewsItem[] } = {}) {
  const db = openDb(':memory:');
  for (const k of opts.holdings ?? []) db.sql.prepare('INSERT INTO holdings (key, market, quantity, avg_price, added_at) VALUES (?, ?, ?, ?, ?)').run(k, k.split(':')[0]!, 1, null, 1);
  for (const k of opts.favorites ?? []) db.sql.prepare('INSERT INTO watchlist (key, market, added_at) VALUES (?, ?, ?)').run(k, k.split(':')[0]!, 2);
  const from = KST('2026-11-27T23:00:00');
  const quotes: Record<string, Quote> = {
    [BTC]: { instrument: parseInstrumentKey(BTC), price: 94000, changePct24h: -2.5, currency: 'USDT', time: 0 },
    [AAPL]: { instrument: parseInstrumentKey(AAPL), price: 361.2, changePct24h: 1.72, currency: 'USD', time: 0 },
    [SS]: { instrument: parseInstrumentKey(SS), price: 179500, changePct24h: 4.8, currency: 'KRW', time: 0 },
  };
  const key = (i: Instrument) => `${i.market}:${i.market === 'us' ? `${i.exchange}:` : ''}${i.symbol}`;
  const market = {
    async getQuote(i: Instrument) { const q = quotes[key(i)]; if (!q) throw new Error('none'); return q; },
    async getCandles(i: Instrument) { if (key(i) !== BTC) throw new Error('none'); return hourly(from, 8, 96800, -400); },
  } as unknown as MarketService;
  const ai = fakeRunAi(script);
  const news = { search: async (q: string) => (opts.news ? opts.news(q) : []) };
  const overview = { get: async () => [
    { id: 'spx', label: 'S&P500', value: 6012.5, changePct: 0.8, note: null, open: false },
    { id: 'nasdaq', label: '나스닥', value: 19250.1, changePct: 1.2, note: null, open: false },
    { id: 'usdkrw', label: '원/달러', value: 1338.2, changePct: null, note: null, open: null },
    { id: 'kimchi', label: '김치 프리미엄', value: 0.57, changePct: null, note: null, open: null },
    { id: 'gold', label: '금', value: 3671, changePct: 3.82, note: null, open: true },
    { id: 'silver', label: '은', value: 43.72, changePct: -1.2, note: null, open: true },
    { id: 'copper', label: '구리', value: 5.5635, changePct: 0.4, note: null, open: true },
  ] as never };
  const deps = { db, market, runAi: ai.runAi, now: () => NOW, news, overview, provider: 'claude' as const, instruments: { nameOf: (k: string) => NAMES[k] ?? null } };
  return { db, ai, deps, args: { from, to: NOW, day: '2026-11-28', origin: 'scheduled' as const } };
}

const submit = (over: Record<string, unknown> = {}): FakeStep => ({ tool: 'submit_overnight', input: {
  headline: '나스닥 +1.2% 마감, 비트코인은 밤새 -2.9%',
  points: ['나스닥 +1.2%로 마감, 반도체 강세', '비트코인 새벽 3시 급락 후 반등 중', '원/달러 1,338원'],
  items: [{ key: BTC, note: 'ETF 자금 유출' }, { key: AAPL, note: '실적 기대감' }],
  news: [{ n: 1, why: '비트코인 하락의 이유' }],
  today: ['9시 개장', '오늘 밤 美 고용지표'],
  ...over,
} });

const inWindow = (title: string, url: string): NewsItem => ({ title, url, source: '뉴스', publishedAt: KST('2026-11-28T03:00:00') / 1000 });

describe('runOvernight', () => {
  test('gathers night numbers for holdings then favorites, gives them and the news to the AI, and stores the result', async () => {
    const s = setup([[submit()]], {
      holdings: [BTC], favorites: [AAPL, BTC],
      news: (q) => (q.includes('비트') ? [inWindow('비트코인 ETF 자금 유출', 'https://n/1'), { ...inWindow('비트코인 옛 소식', 'https://n/old'), publishedAt: KST('2026-11-26T10:00:00') / 1000 }] : []),
    });
    const r = await runOvernight(s.deps, s.args);
    expect(r.facts.items.map((i) => i.key)).toEqual([BTC, AAPL]);
    const btc = r.facts.items[0]!;
    expect(btc).toMatchObject({ kind: 'night', price: 94000, fromPrice: 96800 });
    expect(btc.pct).toBeCloseTo((94000 / 96800 - 1) * 100, 6);
    expect(r.facts.items[1]).toMatchObject({ kind: 'session', price: 361.2, pct: 1.72 });
    expect(r.facts.market.btc).toMatchObject({ from: 96800, to: 94000 });
    expect(r.facts.market.nasdaq).toEqual({ value: 19250.1, changePct: 1.2 });
    expect(r.facts.market.usdkrw).toBe(1338.2);
    expect(r.facts.market.metals).toEqual({ gold: { value: 3671, changePct: 3.82 }, silver: { value: 43.72, changePct: -1.2 }, copper: { value: 5.5635, changePct: 0.4 } });
    expect(s.ai.requests[0]!.userText).toContain('금 $3,671');
    expect(r.facts.news.map((n) => n.url)).toEqual(['https://n/1']);
    const text = s.ai.requests[0]!.userText;
    expect(text).toContain('비트코인 ETF 자금 유출');
    expect(text).not.toContain('옛 소식');
    expect(r).toMatchObject({ headline: '나스닥 +1.2% 마감, 비트코인은 밤새 -2.9%', day: '2026-11-28', origin: 'scheduled', provider: 'claude' });
    expect(latestOvernight(s.db)?.id).toBe(r.id);
  });

  test('works with nothing held or starred: markets only', async () => {
    const s = setup([[submit({ items: [], news: [] })]]);
    const r = await runOvernight(s.deps, s.args);
    expect(r.facts.items).toEqual([]);
    expect(r.points).toHaveLength(3);
  });

  test('a Korean stock is marked as not trading at night', async () => {
    const s = setup([[submit({ items: [{ key: SS, note: '美 반도체 강세가 오늘 호재' }], news: [] })]], { favorites: [SS] });
    const r = await runOvernight(s.deps, s.args);
    expect(r.facts.items[0]).toMatchObject({ key: SS, kind: 'closed' });
  });

  test('an unknown stock or a news number that was not given is refused, then asked again once', async () => {
    const s = setup([[submit({ items: [{ key: 'coin:SOL-USDT', note: 'x' }] })], [submit({ items: [{ key: BTC, note: 'ETF 자금 유출' }], news: [] })]], { holdings: [BTC] });
    await runOvernight(s.deps, s.args);
    expect(s.ai.calls()).toBe(2);
  });

  test('two bad answers end in a readable error', async () => {
    const bad = submit({ news: [{ n: 9, why: 'x' }] });
    const s = setup([[bad], [bad]], { holdings: [BTC] });
    await expect(runOvernight(s.deps, s.args)).rejects.toThrow('밤사이 정리를 만들지 못했어요');
  });
});

describe('when it runs', () => {
  function scheduled(script: FakeStep[][], at: string) {
    const s = setup(script, { holdings: [BTC] });
    let t = KST(at);
    const sent: { title: string; body: string }[] = [];
    const o = createOvernight({ ...s.deps, now: () => t, provider: () => 'gpt', push: { sendAll: async (p) => { sent.push(p); } } });
    return { ...s, o, sent, set: (x: string) => { t = KST(x); } };
  }
  const ok = submit({ items: [{ key: BTC, note: 'ETF 자금 유출' }], news: [] });

  test('nothing before the wake time; at the wake time exactly one recap and one push, even if two checks overlap', async () => {
    const s = scheduled([[ok], [ok]], '2026-11-28T06:59:00');
    await s.o.tick();
    expect(latestOvernight(s.db)).toBeNull();
    s.set('2026-11-28T07:01:00');
    await Promise.all([s.o.tick(), s.o.tick()]);
    expect(overnightHistory(s.db)).toHaveLength(1);
    expect(latestOvernight(s.db)).toMatchObject({ origin: 'scheduled', provider: 'gpt', from: KST('2026-11-27T23:00:00'), to: KST('2026-11-28T07:01:00') });
    expect(s.sent).toEqual([{ title: '밤사이 정리', body: '나스닥 +1.2% 마감, 비트코인은 밤새 -2.9%', url: '/?tab=overnight' }]);
    await s.o.tick();
    expect(s.ai.calls()).toBe(1);
  });

  test('opening the app after the wake time makes it without a push; notifications off means no push either', async () => {
    const s = scheduled([[ok]], '2026-11-28T09:30:00');
    await s.o.ensure({ notify: false });
    expect(latestOvernight(s.db)?.origin).toBe('scheduled');
    expect(s.sent).toEqual([]);
    const off = scheduled([[ok]], '2026-11-28T07:05:00');
    saveSettings(off.db, { ...DEFAULT_SETTINGS, notify: false });
    await off.o.tick();
    expect(latestOvernight(off.db)).not.toBeNull();
    expect(off.sent).toEqual([]);
  });

  test('a failure is shown, is not retried every minute, and a manual rerun still works', async () => {
    const s = scheduled([[{ text: '...' }], [{ text: '...' }], [ok]], '2026-11-28T07:01:00');
    await s.o.tick();
    expect(s.o.state()).toEqual({ making: false, error: '밤사이 정리를 만들지 못했어요' });
    s.set('2026-11-28T07:02:00');
    await s.o.tick();
    expect(s.ai.calls()).toBe(2);
    s.set('2026-11-28T08:00:00');
    await s.o.rerun();
    expect(latestOvernight(s.db)).toMatchObject({ origin: 'manual', to: KST('2026-11-28T08:00:00') });
    expect(s.o.state().error).toBeNull();
  });
});

describe('overnight routes', () => {
  test('read, settings (bad ones refused), history and one recap', async () => {
    const { buildApp } = await import('../../src/app.js');
    const { loginCookie, testDeps } = await import('../helpers.js');
    const s = setup([[submit({ items: [], news: [] })]]);
    const overnight = createOvernight({ ...s.deps, provider: () => 'claude', push: { sendAll: async () => {} } });
    const deps = testDeps({ db: s.db, overnight });
    const app = await buildApp(deps);
    const cookie = await loginCookie(app);
    const get = await app.inject({ method: 'GET', url: '/api/overnight', headers: { cookie } });
    expect(get.json()).toMatchObject({ settings: DEFAULT_SETTINGS, sleepTimes: expect.arrayContaining(['21:00', '02:00']), wakeTimes: expect.arrayContaining(['06:00', '11:00']) });
    expect((await app.inject({ method: 'PUT', url: '/api/overnight/settings', headers: { cookie }, payload: { sleep: '23:00', wake: '05:00', notify: true } })).statusCode).toBe(400);
    const put = await app.inject({ method: 'PUT', url: '/api/overnight/settings', headers: { cookie }, payload: { sleep: '00:30', wake: '06:30', notify: false } });
    expect(put.json().settings).toEqual({ sleep: '00:30', wake: '06:30', notify: false });
    const run = await app.inject({ method: 'POST', url: '/api/overnight/run', headers: { cookie } });
    expect(run.json()).toEqual({ making: true });
    await new Promise((r) => setTimeout(r, 50));
    const h = (await app.inject({ method: 'GET', url: '/api/overnight/history', headers: { cookie } })).json().items;
    expect(h).toHaveLength(1);
    expect((await app.inject({ method: 'GET', url: `/api/overnight/${h[0].id}`, headers: { cookie } })).json().recap.id).toBe(h[0].id);
    expect((await app.inject({ method: 'GET', url: '/api/overnight/999', headers: { cookie } })).statusCode).toBe(404);
  });
});
