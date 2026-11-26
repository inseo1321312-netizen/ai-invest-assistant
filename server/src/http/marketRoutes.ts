import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { MarketService } from '../market/service.js';
import type { Instrument, MarketId, Quote } from '../market/types.js';
import { BARS, instrumentKey, MARKETS, parseInstrumentKey } from '../market/types.js';
import type { Sentiment } from '../market/sentiment.js';

export interface Badge { opinion: string; confidence: '낮음' | '중간' | '높음'; dataTime: number; provider: 'claude' | 'gpt' }
export type BadgeLookup = (keys: string[]) => Map<string, Badge>;

export interface QuoteView { key: string; instrument: Instrument; quote: Quote | null; krwValue: number | null; badge: Badge | null }

export function sourceName(market: MarketId): string {
  return market === 'coin' ? 'OKX' : '한국투자증권';
}

const keySchema = z.string().refine((k) => {
  try { parseInstrumentKey(k); return true; } catch { return false; }
}, '잘못된 종목입니다');

export function registerMarketRoutes(app: FastifyInstance, deps: {
  market: MarketService;
  connected: { kis: boolean };
  badgeLookup?: BadgeLookup;
  sentiment?: (() => Promise<Sentiment | null>) | null;
}) {
  const svc = deps.market;
  const badges = deps.badgeLookup ?? (() => new Map<string, Badge>());

  /** 홈의 "자주 보는 종목": 즐겨찾기 시세(최근 본 종목은 Task 2에서 채운다) */
  app.get('/api/market/:market/overview', async (req, reply) => {
    const market = (req.params as { market: string }).market as MarketId;
    if (!MARKETS.includes(market)) return reply.code(400).send({ error: '잘못된 요청입니다' });
    const errors = new Set<string>();
    const usdKrw = await svc.usdKrw();
    const toView = async (inst: Instrument): Promise<QuoteView> => {
      const key = instrumentKey(inst);
      const quote = await svc.getQuote(inst).catch(() => { errors.add(`${sourceName(market)} 데이터를 가져오지 못했습니다`); return null; });
      const krwValue = quote === null ? null : quote.currency === 'KRW' ? quote.price : usdKrw === null ? null : quote.price * usdKrw;
      return { key, instrument: inst, quote, krwValue, badge: null };
    };
    const favorites = await Promise.all(svc.listWatchlist(market).map(toView));
    const b = badges(favorites.map((f) => f.key));
    for (const f of favorites) f.badge = b.get(f.key) ?? null;
    return { favorites, recent: [] as QuoteView[], usdKrw, errors: [...errors] };
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

  app.get('/api/market/sentiment', async () => ({ sentiment: deps.sentiment ? await deps.sentiment().catch(() => null) : null }));

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
}
