import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Budget } from '../ai/budget.js';
import type { AiRouter } from '../ai/router.js';
import type { Config } from '../config.js';

const tierModels = z.strictObject({ light: z.string().min(1).max(80), standard: z.string().min(1).max(80), deep: z.string().min(1).max(80) });
const usd = z.number().min(0).max(10_000);

const putSchema = z.strictObject({
  models: z.strictObject({ claude: tierModels, gpt: tierModels }).optional(),
  gptMode: z.enum(['siwc', 'apikey']).optional(),
  budget: z.strictObject({ scheduledDailyUsd: usd, interactiveDailyUsd: usd, monthlyUsd: usd, gptMonthlyUsd: usd }).optional(),
});

export function registerSettingsRoutes(app: FastifyInstance, deps: { config: Config; settings: { router: AiRouter; budget: Budget } }) {
  const { router, budget } = deps.settings;
  const c = deps.config;

  // 비밀값은 돌려주지 않는다. 키가 설정됐는지만 알려준다.
  const view = () => ({
    models: router.models(),
    gptMode: router.gptMode(),
    budget: budget.limits(),
    keys: { claude: c.anthropicApiKey !== null, openai: c.openaiApiKey !== null, okx: c.okx !== null, kis: c.kis !== null, push: c.vapid !== null },
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

  app.get('/api/usage', async () => budget.usage());
}
