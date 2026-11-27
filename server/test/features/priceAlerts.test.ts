import { expect, test } from 'vitest';
import { openDb } from '../../src/db.js';
import { parseInstrumentKey, type Instrument, type Quote } from '../../src/market/types.js';
import { addPriceAlert, createPriceAlertMonitor, listPriceAlerts, removePriceAlert, buildPriceAlertTools } from '../../src/features/priceAlerts.js';
import { buildApp } from '../../src/app.js';
import { loginCookie, makeClock, testDeps } from '../helpers.js';

const KST_NOON = Date.parse('2026-11-27T12:00:00+09:00');

function setup(prices: Record<string, number>) {
  const db = openDb(':memory:');
  const clock = makeClock(KST_NOON);
  const sent: { title: string; body: string }[] = [];
  const getQuote = async (inst: Instrument): Promise<Quote> => {
    const key = `${inst.market}:${inst.market === 'us' ? `${inst.exchange}:` : ''}${inst.symbol}`;
    return { instrument: inst, price: prices[key]!, changePct24h: 0, currency: inst.market === 'kr' ? 'KRW' : inst.market === 'us' ? 'USD' : 'USDT', time: 0 };
  };
  const names = { nameOf: (k: string) => ({ 'kr:005930': '삼성전자', 'coin:BTC-USDT': '비트코인' } as Record<string, string>)[k] ?? null };
  const monitor = createPriceAlertMonitor({ db, now: clock.now, getQuote, push: { sendAll: async (p) => { sent.push(p); } }, names });
  return { db, clock, sent, monitor, getQuote, names, prices };
}

test('a target above the current price waits for the price to rise; below waits for a fall', async () => {
  const s = setup({ 'kr:005930': 178200, 'coin:BTC-USDT': 61700 });
  const up = await addPriceAlert(s.db, s.getQuote, 'kr:005930', 180000, s.clock.now());
  const down = await addPriceAlert(s.db, s.getQuote, 'coin:BTC-USDT', 60000, s.clock.now());
  expect(up).toMatchObject({ op: 'above', price: 180000 });
  expect(down).toMatchObject({ op: 'below', price: 60000 });
  expect(listPriceAlerts(s.db, s.names).map((a) => [a.key, a.name, a.op])).toEqual([['coin:BTC-USDT', '비트코인', 'below'], ['kr:005930', '삼성전자', 'above']]);
  removePriceAlert(s.db, down.id);
  expect(listPriceAlerts(s.db).map((a) => a.key)).toEqual(['kr:005930']);
});

test('crossing the target sends one push and clears the alert; not crossing sends nothing', async () => {
  const s = setup({ 'kr:005930': 178200 });
  await addPriceAlert(s.db, s.getQuote, 'kr:005930', 180000, s.clock.now());
  await s.monitor.tick();
  expect(s.sent).toEqual([]);
  s.prices['kr:005930'] = 180300;
  await s.monitor.tick();
  expect(s.sent).toHaveLength(1);
  expect(s.sent[0]!.title).toBe('[목표가] 삼성전자 180,000원 도달');
  expect(s.sent[0]!.body).toContain('180,300원');
  await s.monitor.tick();
  expect(s.sent).toHaveLength(1);
  expect(listPriceAlerts(s.db)).toEqual([]);
});

test('between 2 and 6 a.m. nothing is sent; the alert waits until morning', async () => {
  const s = setup({ 'kr:005930': 178200 });
  await addPriceAlert(s.db, s.getQuote, 'kr:005930', 170000, s.clock.now());
  s.prices['kr:005930'] = 169000;
  s.clock.set(Date.parse('2026-11-28T03:00:00+09:00'));
  await s.monitor.tick();
  expect(s.sent).toEqual([]);
  s.clock.set(Date.parse('2026-11-28T06:01:00+09:00'));
  await s.monitor.tick();
  expect(s.sent).toHaveLength(1);
});

test('the AI can set, list and remove price alerts', async () => {
  const s = setup({ 'kr:005930': 178200 });
  const tools = Object.fromEntries(buildPriceAlertTools({ db: s.db, getQuote: s.getQuote, names: s.names, now: s.clock.now }).map((t) => [t.name, t]));
  expect(Object.keys(tools).sort()).toEqual(['list_price_alerts', 'remove_price_alert', 'set_price_alert']);
  const emitted: unknown[] = [];
  const msg = await tools.set_price_alert!.run({ key: 'kr:005930', price: 180000 }, { emit: (e: unknown) => emitted.push(e) });
  expect(msg).toContain('삼성전자');
  expect(msg).toContain('이상');
  expect(emitted).toContainEqual({ type: 'status', message: '삼성전자 180,000원 이상이면 알려 드릴게요' });
  const list = JSON.parse(await tools.list_price_alerts!.run({}, { emit: () => {} }));
  expect(list).toEqual([expect.objectContaining({ key: 'kr:005930', op: 'above', price: 180000 })]);
  await tools.remove_price_alert!.run({ id: list[0].id }, { emit: () => {} });
  expect(listPriceAlerts(s.db)).toEqual([]);
});

test('price alert routes: add (direction from the current price), list, delete', async () => {
  const deps = testDeps();
  const app = await buildApp(deps);
  const cookie = await loginCookie(app);
  const current = (await deps.market.getQuote(parseInstrumentKey('coin:BTC-USDT'))).price;
  const add = await app.inject({ method: 'POST', url: '/api/price-alerts', headers: { cookie }, payload: { key: 'coin:BTC-USDT', price: current * 2 } });
  expect(add.statusCode).toBe(200);
  expect(add.json().alert).toMatchObject({ op: 'above' });
  const list = (await app.inject({ method: 'GET', url: '/api/price-alerts', headers: { cookie } })).json().alerts;
  expect(list).toHaveLength(1);
  const bad = await app.inject({ method: 'POST', url: '/api/price-alerts', headers: { cookie }, payload: { key: 'coin:BTC-USDT', price: -1 } });
  expect(bad.statusCode).toBe(400);
  await app.inject({ method: 'DELETE', url: `/api/price-alerts/${list[0].id}`, headers: { cookie } });
  expect((await app.inject({ method: 'GET', url: '/api/price-alerts', headers: { cookie } })).json().alerts).toEqual([]);
});
