import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AiRequest } from '../ai/types.js';
import { analysisHistory, latestAnalyses, runTimingAnalysis } from '../features/analysis.js';
import { chatMessages, chatTurn, listChats } from '../features/chat.js';
import type { FeatureDeps } from '../features/deps.js';
import { explainPoint } from '../features/explainPoint.js';
import { BARS, HORIZONS, parseInstrumentKey } from '../market/types.js';
import { sendSse } from '../sse.js';
import type { ModelCatalog } from '../ai/modelCatalog.js';
import type { AiRouter } from '../ai/router.js';

const key = z.string().refine((k) => { try { parseInstrumentKey(k); return true; } catch { return false; } });
const provider = z.enum(['claude', 'gpt']);

/** 요청마다 AbortSignal을 AI 호출에 붙인다(클라이언트가 끊으면 멈춤). */
function withSignal(deps: FeatureDeps, signal: AbortSignal): FeatureDeps {
  return { ...deps, runAi: (req: AiRequest) => deps.runAi({ ...req, signal }) };
}

export function registerAiRoutes(app: FastifyInstance, deps: FeatureDeps & { catalog: ModelCatalog; settings: { router: AiRouter } }) {
  app.get('/api/ai/models', async () => ({ lists: await deps.catalog.list(), defaults: deps.settings.router.models() }));

  app.post('/api/analysis', async (req, reply) => {
    const p = z.object({ key, horizon: z.enum(HORIZONS as ['scalp', 'swing', 'long']), provider, deep: z.boolean().default(false) }).safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: '잘못된 요청입니다' });
    const abort = new AbortController();
    await sendSse(reply, runTimingAnalysis(withSignal(deps, abort.signal), p.data), abort);
  });

  app.post('/api/explain-point', async (req, reply) => {
    const p = z.object({ key, bar: z.enum(BARS as ['1D']), time: z.number().int(), provider }).safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: '잘못된 요청입니다' });
    const abort = new AbortController();
    await sendSse(reply, explainPoint(withSignal(deps, abort.signal), p.data), abort);
  });

  app.post('/api/chat', async (req, reply) => {
    const p = z.object({ chatId: z.number().int().nullable(), key: key.nullable(), provider, model: z.string().max(80).nullable().optional(), text: z.string().min(1).max(4000) }).safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: '잘못된 요청입니다' });
    if (p.data.model && !(await deps.catalog.isAllowed(p.data.provider, p.data.model))) return reply.code(400).send({ error: '고를 수 없는 모델입니다' });
    const abort = new AbortController();
    await sendSse(reply, chatTurn(withSignal(deps, abort.signal), p.data), abort);
  });

  app.get('/api/analysis/latest', async (req, reply) => {
    const p = z.object({ key, horizon: z.enum(HORIZONS as ['scalp', 'swing', 'long']) }).safeParse(req.query);
    if (!p.success) return reply.code(400).send({ error: '잘못된 요청입니다' });
    return { analyses: latestAnalyses(deps.db, p.data.key, p.data.horizon) };
  });

  app.get('/api/analysis/history', async (req, reply) => {
    const p = z.object({ key }).safeParse(req.query);
    if (!p.success) return reply.code(400).send({ error: '잘못된 요청입니다' });
    return { items: analysisHistory(deps.db, p.data.key) };
  });

  app.get('/api/chats', async (req) => {
    const k = (req.query as { key?: string }).key ?? null;
    return { chats: listChats(deps.db, k) };
  });

  app.get('/api/chats/:id/messages', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: '잘못된 요청입니다' });
    return { messages: chatMessages(deps.db, id) };
  });
}
