import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { registerAuth } from './auth.js';
import type { MarketService } from './market/service.js';
import { registerMarketRoutes, type BadgeLookup } from './http/marketRoutes.js';
import type { Sentiment } from './market/sentiment.js';
import { registerAdminRoutes } from './http/adminRoutes.js';
import type { SiwcTokenStore } from './ai/siwcTokens.js';
import { registerAiRoutes } from './http/aiRoutes.js';
import { badgeLookupFor } from './features/analysis.js';
import type { RunAi } from './features/deps.js';
import { registerFeedRoutes } from './http/feedRoutes.js';
import type { Push } from './push.js';
import { registerSettingsRoutes } from './http/settingsRoutes.js';
import type { AiRouter } from './ai/router.js';
import type { Budget } from './ai/budget.js';
import { registerStatic } from './static.js';
import type { ModelCatalog } from './ai/modelCatalog.js';
import { registerDiagnoseRoutes } from './http/diagnoseRoutes.js';
import { registerInfoRoutes } from './http/infoRoutes.js';
import type { InstrumentCatalog } from './market/catalog.js';
import type { Persistence } from './persist.js';

export interface AppDeps {
  config: Config;
  db: Db;
  now: () => number;
  market: MarketService;
  connected: { kis: boolean };
  badgeLookup?: BadgeLookup;
  siwc: SiwcTokenStore;
  runAi: RunAi;
  push: Push;
  runBriefing?: () => Promise<void>;
  catchUp?: () => Promise<void>;
  settings: { router: AiRouter; budget: Budget };
  /** 화면 빌드 폴더(web/dist). 없으면 API만 제공 */
  webDist?: string;
  catalog: ModelCatalog;
  persistence?: Persistence | null;
  checkClaude?: (() => Promise<void>) | null;
  /** 종목 이름·검색(코인·한국·미국) */
  instruments?: InstrumentCatalog | null;
  /** 코인 공포·탐욕 지수 */
  sentiment?: (() => Promise<Sentiment | null>) | null;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, trustProxy: true, bodyLimit: 1024 * 1024 });
  await registerStatic(app, deps.webDist);
  app.get('/api/health', async () => ({ ok: true }));
  await registerAuth(app, deps);
  registerMarketRoutes(app, { ...deps, badgeLookup: deps.badgeLookup ?? badgeLookupFor(deps.db) });
  registerAdminRoutes(app, deps);
  registerAiRoutes(app, deps);
  registerFeedRoutes(app, { ...deps, vapidPublicKey: deps.push.publicKey() });
  registerSettingsRoutes(app, deps);
  registerDiagnoseRoutes(app, deps);
  registerInfoRoutes(app, deps);
  return app;
}
