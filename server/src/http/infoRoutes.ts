import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { InstrumentCatalog } from '../market/catalog.js';

/** 종합 정보 경로: 검색(이후 순위·시장 한눈에·뉴스·종목 정보가 더해진다) */
export function registerInfoRoutes(app: FastifyInstance, deps: { instruments?: InstrumentCatalog | null }) {
  app.get('/api/search', async (req, reply) => {
    const p = z.object({ q: z.string().max(40).default('') }).safeParse(req.query);
    if (!p.success) return reply.code(400).send({ error: '검색어가 너무 길어요' });
    if (!deps.instruments) return { hits: [] };
    return { hits: await deps.instruments.search(p.data.q) };
  });
}
