import type { FastifyInstance } from 'fastify';
import { siwcTokensSchema, type SiwcTokenStore } from '../ai/siwcTokens.js';

export function registerAdminRoutes(app: FastifyInstance, deps: { siwc: SiwcTokenStore }) {
  app.post('/api/admin/siwc-tokens', async (req, reply) => {
    const parsed = siwcTokensSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'ChatGPT 로그인 정보가 올바르지 않습니다' });
    deps.siwc.save(parsed.data);
    return { ok: true };
  });

  app.delete('/api/admin/siwc-tokens', async () => {
    deps.siwc.clear();
    return { ok: true };
  });

  // 토큰 값은 절대 돌려주지 않는다.
  app.get('/api/admin/siwc-status', async () => deps.siwc.status());

  app.get('/api/admin/siwc-host-id', async () => ({ hostId: deps.siwc.hostId(), clientId: deps.siwc.clientId() }));
}
