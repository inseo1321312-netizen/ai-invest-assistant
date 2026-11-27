import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db.js';
import type { MarketService } from '../market/service.js';
import type { News } from '../market/news.js';
import { parseInstrumentKey } from '../market/types.js';
import { listHoldings, removeHolding } from '../features/holdings.js';
import { myNews } from '../features/myNews.js';
import { addPriceAlert, listPriceAlerts, removePriceAlert } from '../features/priceAlerts.js';

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

  app.get('/api/price-alerts', async () => ({ alerts: listPriceAlerts(deps.db, deps.instruments) }));

  app.post('/api/price-alerts', async (req, reply) => {
    const p = z.object({ key: z.string().max(80), price: z.number().positive().finite() }).safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: '가격을 확인해 주세요' });
    try {
      return { alert: await addPriceAlert(deps.db, (i) => deps.market.getQuote(i), p.data.key, p.data.price, deps.now()) };
    } catch (e) {
      return reply.code(400).send({ error: e instanceof Error ? e.message : '알림을 걸지 못했어요' });
    }
  });

  app.delete('/api/price-alerts/:id', async (req, reply) => {
    const p = z.object({ id: z.coerce.number().int().positive() }).safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: '잘못된 요청입니다' });
    removePriceAlert(deps.db, p.data.id);
    return { ok: true };
  });

  app.get('/api/news/mine', async () => {
    if (!deps.news) return { items: [] };
    return { items: await myNews({ db: deps.db, news: deps.news, instruments: deps.instruments, now: deps.now }) };
  });
}
