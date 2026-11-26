import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { buildApp } from './app.js';
import { createOkxClient } from './market/okx.js';
import { createKisClient } from './market/kis.js';
import { createMarketService } from './market/service.js';
import { getUsdKrw } from './market/fx.js';
import { createSiwcTokenStore } from './ai/siwcTokens.js';
import Anthropic from '@anthropic-ai/sdk';
import { createBudget } from './ai/budget.js';
import { createClaudeAdapter } from './ai/claude.js';
import { createGptAdapter } from './ai/gpt.js';
import { createAiRouter } from './ai/router.js';
import type { AiAdapter } from './ai/types.js';
import { createPush } from './push.js';
import { checkSpikesAndLiquidation, runMorningBriefing } from './features/briefing.js';
import { startScheduler } from './scheduler.js';
import { createModelCatalog, fetchGptModels } from './ai/modelCatalog.js';

async function main() {
  const config = loadConfig(process.env);
  mkdirSync(config.dataDir, { recursive: true });
  const db = openDb(path.join(config.dataDir, 'app.db'));
  const now = () => Date.now();
  const okx = createOkxClient({ creds: config.okx });
  const kis = createKisClient({ creds: config.kis, db, now });
  const market = createMarketService({ okx, kis, db, now, fx: () => getUsdKrw({ db, now }) });
  const siwc = createSiwcTokenStore({ db, now });
  const budget = createBudget(db, now);
  const anthropic = config.anthropicApiKey ? new Anthropic({ apiKey: config.anthropicApiKey, maxRetries: 0 }) : null;
  const claude: AiAdapter = anthropic
    ? createClaudeAdapter({ client: anthropic, budget })
    : async function* () { yield { type: 'error', code: 'auth', message: 'Claude API 키(ANTHROPIC_API_KEY)가 설정되지 않았습니다' } as const; };
  let router: ReturnType<typeof createAiRouter>;
  const gpt = createGptAdapter({ mode: () => router.gptMode(), siwc, apiKey: config.openaiApiKey, budget });
  router = createAiRouter({ claude, gpt, db });
  const catalog = createModelCatalog({
    now,
    async listClaude() {
      if (!anthropic) throw new Error('no key');
      const out: { id: string; label: string }[] = [];
      for await (const m of anthropic.models.list()) out.push({ id: m.id, label: m.display_name ?? m.id });
      return out.slice(0, 12);
    },
    async listGpt() {
      const bearer = router.gptMode() === 'apikey' ? config.openaiApiKey : siwc.has() ? await siwc.getAccessToken() : null;
      if (!bearer) throw new Error('not connected');
      return fetchGptModels(bearer);
    },
  });
  const push = createPush({ vapid: config.vapid, db });
  const featureDeps = { db, market, runAi: router.runAi, now, push };
  const runBriefing = () => runMorningBriefing(featureDeps);
  const app = await buildApp({ config, db, now, market, connected: { okx: config.okx !== null, kis: config.kis !== null }, siwc, runAi: router.runAi, push, runBriefing, settings: { router, budget }, catalog, webDist: path.resolve(import.meta.dirname, '../../web/dist') });
  startScheduler({ briefing: runBriefing, spikes: () => checkSpikesAndLiquidation(featureDeps) });
  await app.listen({ host: '0.0.0.0', port: config.port });
  console.log(`서버 시작: 포트 ${config.port}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
