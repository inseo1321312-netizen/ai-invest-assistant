import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AiRequest } from '../ai/types.js';
import type { FeatureDeps } from '../features/deps.js';
import { compareHistory, getCompare, runCompare } from '../features/compare.js';
import { HORIZONS, parseInstrumentKey } from '../market/types.js';
import { sendSse } from '../sse.js';

const key = z.string().max(80).refine((k) => { try { parseInstrumentKey(k); return true; } catch { return false; } });

/** 비교 탭: 비교하기(SSE), 지난 비교, 결과 하나, 빠른 추가(보유 → 즐겨찾기) */
export function registerCompareRoutes(app: FastifyInstance, deps: FeatureDeps) {
  app.post('/api/compare', async (req, reply) => {
    const p = z.object({
      keys: z.array(key).min(2).max(4).refine((ks) => new Set(ks).size === ks.length),
      horizon: z.enum(HORIZONS as ['scalp', 'swing', 'long']),
      provider: z.enum(['claude', 'gpt']),
    }).safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: '2~4개를 겹치지 않게 골라 주세요' });
    const abort = new AbortController();
    const withSignal: FeatureDeps = { ...deps, runAi: (r: AiRequest) => deps.runAi({ ...r, signal: abort.signal }) };
    await sendSse(reply, runCompare(withSignal, p.data), abort);
  });

  app.get('/api/compare/history', async () => ({ items: compareHistory(deps.db) }));

  app.get('/api/compare/suggest', async () => {
    const rows = deps.db.sql.prepare(`SELECT key, kind FROM (SELECT key, added_at, 0 AS kind FROM holdings UNION ALL SELECT key, added_at, 1 AS kind FROM watchlist)
      ORDER BY kind, added_at DESC`).all() as { key: string; kind: number }[];
    const seen = new Set<string>();
    const items: { key: string; name: string | null; source: 'holding' | 'favorite' }[] = [];
    for (const r of rows) {
      if (seen.has(r.key) || items.length >= 12) continue;
      seen.add(r.key);
      items.push({ key: r.key, name: deps.instruments?.nameOf(r.key) ?? null, source: r.kind === 0 ? 'holding' : 'favorite' });
    }
    return { items };
  });

  app.get('/api/compare/:id', async (req, reply) => {
    const p = z.object({ id: z.coerce.number().int().positive() }).safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: '잘못된 요청입니다' });
    const result = getCompare(deps.db, p.data.id);
    if (!result) return reply.code(404).send({ error: '지난 비교를 찾지 못했어요' });
    return { result };
  });
}
