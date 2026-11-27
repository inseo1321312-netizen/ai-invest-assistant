import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db.js';
import type { MarketService } from '../market/service.js';
import type { News } from '../market/news.js';
import { parseInstrumentKey } from '../market/types.js';
import { listHoldings, removeHolding } from '../features/holdings.js';
import { myNews } from '../features/myNews.js';

/** 보유 종목(시세·수익률 포함)과 '오늘 소식'(보유·즐겨찾기 종목 뉴스) */
export function registerHoldingsRoutes(app: FastifyInstance, deps: {
  db: Db;
  market: MarketService;
  now: () => number;
  news?: Pick<News, 'search'> | null;
  instruments?: { nameOf(key: string): string | null } | null;
}) {
  app.get('/api/holdings', async () => {
    const items = await Promise.all(listHoldings(deps.db, deps.instruments).map(async (h) => {
      const instrument = parseInstrumentKey(h.key);
      const quote = await deps.market.getQuote(instrument).catch(() => null);
      const plPct = quote && h.avgPrice ? (quote.price / h.avgPrice - 1) * 100 : null;
      return { ...h, instrument: { ...instrument, name: h.name }, quote, plPct };
    }));
    return { items };
  });

  app.delete('/api/holdings', async (req, reply) => {
    const p = z.object({ key: z.string().max(80) }).safeParse(req.query);
    if (!p.success) return reply.code(400).send({ error: '잘못된 요청입니다' });
    removeHolding(deps.db, p.data.key);
    return { ok: true };
  });

  app.get('/api/news/mine', async () => {
    if (!deps.news) return { items: [] };
    return { items: await myNews({ db: deps.db, news: deps.news, instruments: deps.instruments, now: deps.now }) };
  });
}
