import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { MarketService } from '../market/service.js';
import type { Holding, Instrument, MarketId, Quote } from '../market/types.js';
import { BARS, instrumentKey, MARKETS, parseInstrumentKey } from '../market/types.js';

export interface Badge { opinion: string; confidence: '낮음' | '중간' | '높음'; dataTime: number; provider: 'claude' | 'gpt' }
export type BadgeLookup = (keys: string[]) => Map<string, Badge>;

export interface HoldingView extends Holding { key: string; quote: Quote | null; krwValue: number | null; pnlPct: number | null; badge: Badge | null }
export interface QuoteView { key: string; instrument: Instrument; quote: Quote | null; krwValue: number | null; badge: Badge | null }

export function sourceName(market: MarketId): string {
  return market === 'coin' ? 'OKX' : '한국투자증권';
}

const keySchema = z.string().refine((k) => {
  try { parseInstrumentKey(k); return true; } catch { return false; }
}, '잘못된 종목입니다');

export function pnlPct(h: Holding, price: number | null): number | null {
  if (price === null || !h.avgPrice) return null;
  const pct = ((price - h.avgPrice) / h.avgPrice) * 100;
  return h.side === 'short' ? -pct : pct;
}

export function registerMarketRoutes(app: FastifyInstance, deps: {
  market: MarketService;
  connected: { okx: boolean; kis: boolean };
  badgeLookup?: BadgeLookup;
}) {
  const svc = deps.market;
  const badges = deps.badgeLookup ?? (() => new Map<string, Badge>());

  app.get('/api/market/:market/overview', async (req, reply) => {
    const market = (req.params as { market: string }).market as MarketId;
    if (!MARKETS.includes(market)) return reply.code(400).send({ error: '잘못된 요청입니다' });
    const errors = new Set<string>();
    const failed = () => errors.add(`${sourceName(market)} 데이터를 가져오지 못했습니다`);
    const auto = await svc.getAutoHoldings(market).catch(() => { failed(); return [] as Holding[]; });
    const holdings: Holding[] = [...auto, ...svc.getManualHoldings(market).map(({ manualId, ...h }) => ({ ...h, manualId }))];
    const watch = svc.listWatchlist(market);
    const usdKrw = await svc.usdKrw();
    const quoteOf = (inst: Instrument) => svc.getQuote(inst).catch(() => { failed(); return null; });
    const toKrw = (value: number, currency: string) => (currency === 'KRW' ? value : usdKrw === null ? null : value * usdKrw);
    const keys = [...holdings.map((h) => instrumentKey(h.instrument)), ...watch.map(instrumentKey)];
    const b = badges(keys);

    const holdingViews: HoldingView[] = await Promise.all(holdings.map(async (h) => {
      const quote = await quoteOf(h.instrument);
      const price = quote?.price ?? h.markPrice ?? null;
      const key = instrumentKey(h.instrument);
      return { ...h, key, quote, krwValue: price === null ? null : toKrw(price * h.quantity, h.currency), pnlPct: pnlPct(h, price), badge: b.get(key) ?? null };
    }));
    const watchViews: QuoteView[] = await Promise.all(watch.map(async (inst) => {
      const quote = await quoteOf(inst);
      const key = instrumentKey(inst);
      return { key, instrument: inst, quote, krwValue: quote ? toKrw(quote.price, quote.currency) : null, badge: b.get(key) ?? null };
    }));
    return {
      holdings: holdingViews,
      watchlist: watchViews,
      usdKrw,
      connected: market === 'coin' ? deps.connected.okx : deps.connected.kis,
      errors: [...errors, ...svc.notices(market)],
    };
  });

  app.get('/api/market/candles', async (req, reply) => {
    const parsed = z.object({
      key: keySchema,
      bar: z.enum(BARS as [string, ...string[]]),
      limit: z.coerce.number().int().min(1).max(500).default(200),
    }).safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: '잘못된 요청입니다' });
    const inst = parseInstrumentKey(parsed.data.key);
    try {
      return { candles: await svc.getCandles(inst, parsed.data.bar as never, parsed.data.limit) };
    } catch {
      return reply.code(502).send({ error: `${sourceName(inst.market)} 데이터를 가져오지 못했습니다` });
    }
  });

  // 목록의 작은 추세선: 종목마다 최근 일봉 종가 30개. 실패한 종목은 빼고 돌려준다.
  app.get('/api/market/sparklines', async (req) => {
    const raw = String((req.query as { keys?: string }).keys ?? '');
    const keys = [...new Set(raw.split(',').map((k) => k.trim()).filter(Boolean))].slice(0, 40);
    const out: Record<string, number[]> = {};
    await Promise.all(keys.map(async (k) => {
      try {
        const candles = await svc.getCandles(parseInstrumentKey(k), '1D', 30);
        out[k] = candles.map((c) => c.close);
      } catch { /* 건너뜀 */ }
    }));
    return { sparklines: out };
  });

  app.get('/api/market/quote', async (req, reply) => {
    const parsed = z.object({ key: keySchema }).safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: '잘못된 요청입니다' });
    const inst = parseInstrumentKey(parsed.data.key);
    try {
      return { quote: await svc.getQuote(inst) };
    } catch {
      return reply.code(502).send({ error: `${sourceName(inst.market)} 데이터를 가져오지 못했습니다` });
    }
  });

  app.post('/api/watchlist', async (req, reply) => {
    const parsed = z.object({ key: keySchema }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: '잘못된 종목입니다' });
    svc.addWatch(parsed.data.key);
    return { ok: true };
  });

  app.delete('/api/watchlist', async (req, reply) => {
    const parsed = z.object({ key: z.string() }).safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: '잘못된 요청입니다' });
    svc.removeWatch(parsed.data.key);
    return { ok: true };
  });

  app.post('/api/manual-holdings', async (req, reply) => {
    const parsed = z.object({
      key: keySchema,
      quantity: z.number().positive(),
      avgPrice: z.number().min(0),
      side: z.enum(['long', 'short']).nullable(),
      leverage: z.number().positive().max(200).nullable(),
    }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: '입력값을 확인하세요' });
    return { id: svc.addManualHolding(parsed.data) };
  });

  app.delete('/api/manual-holdings/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: '잘못된 요청입니다' });
    svc.removeManualHolding(id);
    return { ok: true };
  });
}
