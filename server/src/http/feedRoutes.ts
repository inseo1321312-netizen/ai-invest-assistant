import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { kstDay } from '../ai/budget.js';
import type { Db } from '../db.js';
import { listFeed } from '../features/briefing.js';
import type { Push } from '../push.js';

export function registerFeedRoutes(app: FastifyInstance, deps: {
  db: Db;
  now: () => number;
  push: Push;
  vapidPublicKey: string | null;
  runBriefing?: () => Promise<void>;
  /** 앱이 소식을 불러갈 때 밀린 작업(오늘 브리핑, 급변 확인)을 뒤에서 돌린다 */
  catchUp?: () => Promise<void>;
}) {
  let briefingRunning = false;

  app.get('/api/feed', async (req, reply) => {
    const p = z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).safeParse(req.query);
    if (!p.success) return reply.code(400).send({ error: '잘못된 요청입니다' });
    if (deps.catchUp) void deps.catchUp().catch(() => undefined);
    return { items: listFeed(deps.db, p.data.day ?? kstDay(deps.now())) };
  });

  app.get('/api/push/public-key', async () => ({ publicKey: deps.vapidPublicKey }));

  app.post('/api/push/subscribe', async (req, reply) => {
    const p = z.object({ endpoint: z.string().url().max(2000), keys: z.object({ p256dh: z.string().max(500), auth: z.string().max(500) }) }).safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: '알림 구독 정보가 올바르지 않습니다' });
    deps.push.subscribe(p.data);
    return { ok: true };
  });

  app.post('/api/admin/run-briefing', async (_req, reply) => {
    if (!deps.runBriefing) return reply.code(503).send({ error: '브리핑을 실행할 수 없습니다' });
    if (briefingRunning) return reply.code(409).send({ error: '브리핑이 이미 실행 중입니다' });
    briefingRunning = true;
    deps.runBriefing()
      .catch((err) => console.error('수동 브리핑 실패', err instanceof Error ? err.message : err))
      .finally(() => { briefingRunning = false; });
    return reply.code(202).send({ started: true });
  });
}
