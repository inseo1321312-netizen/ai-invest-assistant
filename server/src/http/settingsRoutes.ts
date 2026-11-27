import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Budget } from '../ai/budget.js';
import { checkKeyShape, type ApiKeys, type KeyProvider, type VerifyResult } from '../ai/apiKeys.js';
import type { AiRouter } from '../ai/router.js';
import type { Config } from '../config.js';

const tierModels = z.strictObject({ light: z.string().min(1).max(80), standard: z.string().min(1).max(80), deep: z.string().min(1).max(80) });
const usd = z.number().min(0).max(10_000);

const putSchema = z.strictObject({
  models: z.strictObject({ claude: tierModels, gpt: tierModels }).optional(),
  gptMode: z.enum(['siwc', 'apikey']).optional(),
  budget: z.strictObject({ scheduledDailyUsd: usd, interactiveDailyUsd: usd, monthlyUsd: usd, gptMonthlyUsd: usd }).optional(),
});

const keySchema = z.strictObject({ provider: z.enum(['claude', 'openai']), key: z.string().trim().min(1).max(400) });
const NAME: Record<KeyProvider, string> = { claude: 'Claude', openai: 'ChatGPT' };

export function registerSettingsRoutes(app: FastifyInstance, deps: { config: Config; settings: { router: AiRouter; budget: Budget; keys: ApiKeys; verifyKey: (p: KeyProvider, key: string) => Promise<VerifyResult> } }) {
  const { router, budget, keys } = deps.settings;
  const c = deps.config;

  // 비밀값은 돌려주지 않는다. 키가 설정됐는지만 알려준다.
  const view = () => ({
    models: router.models(),
    gptMode: router.gptMode(),
    budget: budget.limits(),
    keys: { claude: keys.get('claude') !== null, openai: keys.get('openai') !== null, kis: c.kis !== null, push: c.vapid !== null },
    apiKeys: { claude: keys.info('claude'), openai: keys.info('openai') },
  });

  app.get('/api/settings', async () => view());

  app.put('/api/settings', async (req, reply) => {
    const p = putSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: '설정 값을 확인하세요' });
    if (p.data.models) router.setModels(p.data.models);
    if (p.data.gptMode) router.setGptMode(p.data.gptMode);
    if (p.data.budget) budget.setLimits(p.data.budget);
    return view();
  });

  // 앱에서 API 키 넣기: 모양 → 실제로 맞는지 확인 → 암호화해서 저장. ChatGPT 키는 GPT를 API 방식으로 바꾼다
  app.put('/api/settings/api-key', async (req, reply) => {
    const p = keySchema.safeParse(req.body);
    if (!p.success || !checkKeyShape(p.data.provider, p.data.key)) {
      return reply.code(400).send({ error: p.success ? `${NAME[p.data.provider]} API 키 형식이 아니에요` : 'API 키를 넣어 주세요' });
    }
    const { provider, key } = p.data;
    const result = await deps.settings.verifyKey(provider, key);
    if (result === 'bad') return reply.code(400).send({ error: `키가 맞지 않아요. ${NAME[provider]} API 키를 다시 확인해 주세요` });
    if (result === 'unreachable') return reply.code(502).send({ error: `${NAME[provider]}에 연결하지 못했어요. 잠시 뒤 다시 해 주세요` });
    keys.set(provider, key);
    if (provider === 'openai') router.setGptMode('apikey');
    return view();
  });

  app.delete('/api/settings/api-key', async (req, reply) => {
    const p = z.object({ provider: z.enum(['claude', 'openai']) }).safeParse(req.query);
    if (!p.success) return reply.code(400).send({ error: '잘못된 요청입니다' });
    keys.clear(p.data.provider);
    if (p.data.provider === 'openai' && !keys.get('openai')) router.setGptMode('siwc');
    return view();
  });

  app.get('/api/usage', async () => budget.usage());
}
