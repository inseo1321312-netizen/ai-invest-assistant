import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { InstrumentCatalog } from '../market/catalog.js';
import type { InstrumentInfo } from '../market/instrumentInfo.js';
import type { News } from '../market/news.js';
import { newsQueryFor } from '../market/news.js';
import type { MarketOverview } from '../market/overview.js';
import type { Trending } from '../market/trending.js';
import { MARKETS, parseInstrumentKey, type MarketId } from '../market/types.js';

const keySchema = z.string().refine((k) => { try { parseInstrumentKey(k); return true; } catch { return false; } });

/** 종합 정보 경로: 검색(이후 순위·시장 한눈에·뉴스·종목 정보가 더해진다) */
export function registerInfoRoutes(app: FastifyInstance, deps: {
  instruments?: InstrumentCatalog | null;
  trending?: Trending | null;
  overview?: MarketOverview | null;
  news?: News | null;
  instrumentInfo?: InstrumentInfo | null;
  connected?: { kis: boolean };
}) {
  app.get('/api/search', async (req, reply) => {
    const p = z.object({ q: z.string().max(40).default('') }).safeParse(req.query);
    if (!p.success) return reply.code(400).send({ error: '검색어가 너무 길어요' });
    if (!deps.instruments) return { hits: [] };
    return { hits: await deps.instruments.search(p.data.q) };
  });

  app.get('/api/trending/:market', async (req, reply) => {
    const market = (req.params as { market: string }).market as MarketId;
    const p = z.object({ kind: z.enum(['gainers', 'value']).default('gainers') }).safeParse(req.query);
    if (!MARKETS.includes(market) || !p.success) return reply.code(400).send({ error: '잘못된 요청입니다' });
    const needsKey = market !== 'coin' && !deps.connected?.kis;
    if (!deps.trending) return { items: [], needsKey };
    return { items: await deps.trending.get(market, p.data.kind).catch(() => []), needsKey };
  });

  app.get('/api/news', async (req, reply) => {
    const p = z.object({ key: keySchema, from: z.coerce.number().int().positive().optional(), to: z.coerce.number().int().positive().optional() }).safeParse(req.query);
    if (!p.success) return reply.code(400).send({ error: '잘못된 요청입니다' });
    if (!deps.news) return { items: [] };
    const query = newsQueryFor(parseInstrumentKey(p.data.key), deps.instruments?.nameOf(p.data.key) ?? null);
    const range = p.data.from && p.data.to ? { from: p.data.from, to: p.data.to } : undefined;
    return { items: await deps.news.search(query, range) };
  });

  app.get('/api/instrument/info', async (req, reply) => {
    const p = z.object({ key: keySchema }).safeParse(req.query);
    if (!p.success) return reply.code(400).send({ error: '잘못된 요청입니다' });
    if (!deps.instrumentInfo) return { stock: null, coin: null };
    return deps.instrumentInfo.get(p.data.key);
  });

  app.get('/api/market-overview', async () => ({ items: deps.overview ? await deps.overview.get() : [] }));
}
