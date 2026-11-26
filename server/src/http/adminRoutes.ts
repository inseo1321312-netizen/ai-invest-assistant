import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { buildAuthorizeUrl, exchangeCode, makePkce, randomToken } from '../ai/siwcLogin.js';
import { SIWC_REDIRECT_HOST, SIWC_REDIRECT_PATH, SIWC_REDIRECT_PORT } from '../ai/siwcConfig.js';
import { siwcTokensSchema, type SiwcTokens, type SiwcTokenStore } from '../ai/siwcTokens.js';

/** OpenAI가 허용하는 콜백은 127.0.0.1 루프백뿐이다. 폰에서는 이 주소가 열리지 않으니 사용자가 주소를 복사해 붙여넣는다. */
const PHONE_REDIRECT = `http://${SIWC_REDIRECT_HOST}:${SIWC_REDIRECT_PORT}${SIWC_REDIRECT_PATH}`;
const PENDING_MS = 10 * 60_000;

type Exchange = (p: { clientId: string; code: string; verifier: string; redirectUri: string }) => Promise<SiwcTokens>;

export function registerAdminRoutes(app: FastifyInstance, deps: { siwc: SiwcTokenStore; now?: () => number; siwcExchange?: Exchange }) {
  const now = deps.now ?? Date.now;
  const exchange: Exchange = deps.siwcExchange ?? ((p) => exchangeCode(p));
  let pending: { verifier: string; state: string; createdAt: number } | null = null;

  app.post('/api/admin/siwc-tokens', async (req, reply) => {
    const parsed = siwcTokensSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: '토큰 형식이 올바르지 않습니다' });
    deps.siwc.save(parsed.data);
    return { ok: true };
  });

  app.delete('/api/admin/siwc-tokens', async () => {
    deps.siwc.clear();
    return { ok: true };
  });

  app.get('/api/admin/siwc-status', async () => deps.siwc.status());

  app.get('/api/admin/siwc-host-id', async () => ({ hostId: deps.siwc.hostId(), clientId: deps.siwc.clientId() }));

  // 폰에서 ChatGPT 연결: 1) OpenAI 로그인 주소 받기
  app.post('/api/admin/siwc-login/start', async () => {
    const { verifier, challenge } = makePkce();
    const state = randomToken();
    pending = { verifier, state, createdAt: now() };
    return { url: buildAuthorizeUrl({ clientId: deps.siwc.clientId(), redirectUri: PHONE_REDIRECT, challenge, state, nonce: randomToken(), hostId: deps.siwc.hostId() }) };
  });

  // 2) 사파리 주소창에서 복사한 127.0.0.1 주소를 붙여넣으면 토큰으로 바꿔 저장한다
  app.post('/api/admin/siwc-login/finish', async (req, reply) => {
    const fail = (error: string) => reply.code(400).send({ error });
    const p = z.object({ url: z.string().max(4000) }).safeParse(req.body);
    let url: URL;
    try {
      url = new URL((p.success ? p.data.url : '').trim());
    } catch {
      return fail('주소를 확인해 주세요. 사파리 주소창의 주소 전체를 복사해야 해요');
    }
    const q = url.searchParams;
    if (!pending) return fail('로그인을 처음부터 다시 해 주세요');
    if (now() - pending.createdAt > PENDING_MS) {
      pending = null;
      return fail('시간이 지나서 다시 해 주세요. ChatGPT 연결을 다시 누르면 돼요');
    }
    if (q.get('error')) return fail('로그인이 취소됐어요. 다시 해 주세요');
    if (q.get('state') !== pending.state) return fail('로그인을 처음부터 다시 해 주세요(다른 로그인 창의 주소예요)');
    const code = q.get('code');
    if (!code) return fail('주소에 로그인 코드가 없어요. 주소창의 주소 전체를 복사해 주세요');
    const clientId = q.get('client_id') ?? deps.siwc.clientId();
    if (!clientId) return fail('주소에 앱 정보가 없어요. 주소창의 주소 전체를 복사해 주세요');
    try {
      const tokens = await exchange({ clientId, code, verifier: pending.verifier, redirectUri: PHONE_REDIRECT });
      deps.siwc.save(tokens);
      pending = null;
      return { ok: true };
    } catch (err) {
      return fail(err instanceof Error ? err.message : 'ChatGPT 연결에 실패했어요');
    }
  });
}
