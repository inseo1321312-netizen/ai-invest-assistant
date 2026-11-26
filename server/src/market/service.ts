import type { Db } from '../db.js';
import type { KisClient } from './kis.js';
import type { OkxClient } from './okx.js';
import type { Bar, Candle, Holding, Instrument, MarketId, Quote } from './types.js';
import { BAR_SECONDS, instrumentKey, MARKET_CURRENCY, parseInstrumentKey } from './types.js';

export interface ManualHoldingInput {
  key: string;
  quantity: number;
  avgPrice: number;
  side: 'long' | 'short' | null;
  leverage: number | null;
}

export interface MarketService {
  getCandles(inst: Instrument, bar: Bar, limit: number): Promise<Candle[]>;
  getQuote(inst: Instrument): Promise<Quote>;
  /** 자동(OKX/KIS) 보유. 출처 오류는 그대로 던진다. */
  getAutoHoldings(market: MarketId): Promise<Holding[]>;
  getManualHoldings(market: MarketId): (Holding & { manualId: number })[];
  getHoldings(market: MarketId): Promise<Holding[]>;
  listWatchlist(market: MarketId): Instrument[];
  addWatch(key: string): void;
  removeWatch(key: string): void;
  addManualHolding(h: ManualHoldingInput): number;
  removeManualHolding(id: number): void;
  usdKrw(): Promise<number | null>;
  /** 사용자에게 알릴 안내(예: 지원하지 않아 뺀 OKX 상품) */
  notices(market: MarketId): string[];
}

const TTL_MS: Record<Bar, number> = {
  '1m': 30_000, '5m': 30_000, '15m': 120_000, '1H': 120_000, '4H': 600_000, '1D': 1_800_000, '1W': 1_800_000,
};
const QUOTE_TTL_MS = 10_000;
const HOLDINGS_TTL_MS = 30_000;

export function createMarketService(deps: {
  okx: OkxClient;
  kis: KisClient;
  db: Db;
  now: () => number;
  fx: () => Promise<number | null>;
}): MarketService {
  const { db, now } = deps;
  const q = {
    readCandles: db.sql.prepare('SELECT time, o, h, l, c, v FROM candles WHERE key = ? AND bar = ? ORDER BY time DESC LIMIT ?'),
    countCandles: db.sql.prepare('SELECT COUNT(*) AS n, MAX(time) AS newest FROM candles WHERE key = ? AND bar = ?'),
    upsertCandle: db.sql.prepare('INSERT INTO candles (key, bar, time, o, h, l, c, v) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(key, bar, time) DO UPDATE SET o=excluded.o, h=excluded.h, l=excluded.l, c=excluded.c, v=excluded.v'),
    meta: db.sql.prepare('SELECT fetched_at FROM candle_meta WHERE key = ? AND bar = ?'),
    setMeta: db.sql.prepare('INSERT INTO candle_meta (key, bar, fetched_at) VALUES (?, ?, ?) ON CONFLICT(key, bar) DO UPDATE SET fetched_at = excluded.fetched_at'),
    watchAdd: db.sql.prepare('INSERT OR IGNORE INTO watchlist (key, market, added_at) VALUES (?, ?, ?)'),
    watchDel: db.sql.prepare('DELETE FROM watchlist WHERE key = ?'),
    watchList: db.sql.prepare('SELECT key FROM watchlist WHERE market = ? ORDER BY added_at'),
    manualAdd: db.sql.prepare('INSERT INTO manual_holdings (key, market, quantity, avg_price, currency, side, leverage) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    manualDel: db.sql.prepare('DELETE FROM manual_holdings WHERE id = ?'),
    manualList: db.sql.prepare('SELECT id, key, quantity, avg_price, currency, side, leverage FROM manual_holdings WHERE market = ? ORDER BY id'),
  };
  const quoteCache = new Map<string, { at: number; quote: Quote }>();
  const holdingsCache = new Map<string, { at: number; holdings: Holding[] }>();

  async function fetchCandles(inst: Instrument, bar: Bar, limit: number): Promise<Candle[]> {
    return inst.market === 'coin' ? deps.okx.getCandles(inst.symbol, bar, limit) : deps.kis.getCandles(inst, bar, limit);
  }

  function readCached(key: string, bar: Bar, limit: number): Candle[] {
    const rows = q.readCandles.all(key, bar, limit) as { time: number; o: number; h: number; l: number; c: number; v: number }[];
    return rows.reverse().map((r) => ({ time: r.time, open: r.o, high: r.h, low: r.l, close: r.c, volume: r.v }));
  }

  function store(key: string, bar: Bar, candles: Candle[]) {
    db.sql.exec('BEGIN');
    try {
      for (const c of candles) q.upsertCandle.run(key, bar, c.time, c.open, c.high, c.low, c.close, c.volume);
      q.setMeta.run(key, bar, now());
      db.sql.exec('COMMIT');
    } catch (err) {
      db.sql.exec('ROLLBACK');
      throw err;
    }
  }

  return {
    async getCandles(inst, bar, limit) {
      const key = instrumentKey(inst);
      const meta = q.meta.get(key, bar) as { fetched_at: number } | undefined;
      const stat = q.countCandles.get(key, bar) as { n: number; newest: number | null };
      const fresh = meta && now() - meta.fetched_at < TTL_MS[bar];
      if (fresh && stat.n >= limit) return readCached(key, bar, limit);

      const nowSec = Math.floor(now() / 1000);
      const recentEnough = stat.newest !== null && stat.newest >= nowSec - 3 * BAR_SECONDS[bar];
      let fetchLimit = limit;
      if (stat.n >= limit && recentEnough) {
        // 마감된 캔들은 다시 받지 않는다: 마지막 캔들부터 지금까지만.
        fetchLimit = Math.min(limit, Math.ceil((nowSec - stat.newest!) / BAR_SECONDS[bar]) + 2);
      }
      const fetched = await fetchCandles(inst, bar, fetchLimit);
      store(key, bar, fetched);
      return readCached(key, bar, limit);
    },

    async getQuote(inst) {
      const key = instrumentKey(inst);
      const hit = quoteCache.get(key);
      if (hit && now() - hit.at < QUOTE_TTL_MS) return hit.quote;
      const quote = inst.market === 'coin' ? await deps.okx.getQuote(inst.symbol) : await deps.kis.getQuote(inst);
      quoteCache.set(key, { at: now(), quote });
      return quote;
    },

    async getAutoHoldings(market) {
      const hit = holdingsCache.get(market);
      if (hit && now() - hit.at < HOLDINGS_TTL_MS) return hit.holdings;
      let holdings: Holding[];
      if (market === 'coin') holdings = await deps.okx.getHoldings();
      else {
        const all = await deps.kis.getHoldings();
        for (const m of ['kr', 'us'] as const) {
          holdingsCache.set(m, { at: now(), holdings: all.filter((h) => h.instrument.market === m) });
        }
        holdings = all.filter((h) => h.instrument.market === market);
      }
      holdingsCache.set(market, { at: now(), holdings });
      return holdings;
    },

    getManualHoldings(market) {
      const rows = q.manualList.all(market) as { id: number; key: string; quantity: number; avg_price: number; currency: string; side: string | null; leverage: number | null }[];
      return rows.map((r) => ({
        manualId: r.id,
        instrument: parseInstrumentKey(r.key),
        quantity: r.quantity,
        avgPrice: r.avg_price,
        currency: r.currency as Holding['currency'],
        source: 'manual' as const,
        side: (r.side as Holding['side']) ?? null,
        leverage: r.leverage,
        liqPrice: null,
        markPrice: null,
        unrealizedPnl: null,
        fundingRate: null,
      }));
    },

    async getHoldings(market) {
      const auto = await this.getAutoHoldings(market);
      return [...auto, ...this.getManualHoldings(market)];
    },

    listWatchlist(market) {
      return (q.watchList.all(market) as { key: string }[]).map((r) => parseInstrumentKey(r.key));
    },

    addWatch(key) {
      const inst = parseInstrumentKey(key);
      q.watchAdd.run(instrumentKey(inst), inst.market, now());
    },

    removeWatch(key) {
      q.watchDel.run(key);
    },

    addManualHolding(h) {
      const inst = parseInstrumentKey(h.key);
      const res = q.manualAdd.run(instrumentKey(inst), inst.market, h.quantity, h.avgPrice, MARKET_CURRENCY[inst.market], h.side, h.leverage);
      return Number(res.lastInsertRowid);
    },

    removeManualHolding(id) {
      q.manualDel.run(id);
    },

    usdKrw: deps.fx,

    notices(market) {
      if (market !== 'coin') return [];
      const u = deps.okx.unsupported();
      return u.length ? [`OKX의 일부 상품(${u.join(', ')})은 아직 지원하지 않아 목록에서 빠졌어요`] : [];
    },
  };
}
