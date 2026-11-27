import type { ApiKeys, KeyProvider, VerifyResult } from './ai/apiKeys.js';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { registerAuth } from './auth.js';
import type { MarketService } from './market/service.js';
import { registerMarketRoutes, type BadgeLookup } from './http/marketRoutes.js';
import type { Sentiment } from './market/sentiment.js';
import { registerAdminRoutes } from './http/adminRoutes.js';
import type { SiwcTokens, SiwcTokenStore } from './ai/siwcTokens.js';
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
import { registerHoldingsRoutes } from './http/holdingsRoutes.js';
import { registerAlertRoutes } from './http/alertRoutes.js';
import type { InstrumentCatalog } from './market/catalog.js';
import type { MarketOverview } from './market/overview.js';
import type { News } from './market/news.js';
import type { InstrumentInfo } from './market/instrumentInfo.js';
import type { UpbitClient } from './market/upbit.js';
import type { Logos } from './market/logos.js';
import type { KisClient } from './market/kis.js';
import type { Trending } from './market/trending.js';
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
  settings: { router: AiRouter; budget: Budget; keys: ApiKeys; verifyKey: (p: KeyProvider, key: string) => Promise<VerifyResult> };
  /** 화면 빌드 폴더(web/dist). 없으면 API만 제공 */
  webDist?: string;
  catalog: ModelCatalog;
  persistence?: Persistence | null;
  checkClaude?: (() => Promise<boolean | void>) | null;
  /** 종목 이름·검색(코인·한국·미국) */
  instruments?: InstrumentCatalog | null;
  /** 지금 뜨는 종목 */
  trending?: Trending | null;
  /** 오늘 시장 한눈에 */
  overview?: MarketOverview | null;
  /** 종목 뉴스(Google 뉴스) */
  news?: News | null;
  /** 종목 기본 지표·선물 지표·김프 */
  instrumentInfo?: InstrumentInfo | null;
  /** ChatGPT 로그인 코드 교환(테스트에서 바꿔 끼움) */
  siwcExchange?: (p: { clientId: string; code: string; verifier: string; redirectUri: string }) => Promise<SiwcTokens>;
  /** 앱키 없이도 주식 시세가 되는지(네이버 증권) */
  stocksAvailable?: boolean;
  /** 네이버 증권(연결 점검용) */
  naver?: Pick<KisClient, 'getQuote'> | null;
  /** 한투 클라이언트 자체(연결 점검용) */
  kis?: Pick<KisClient, 'getQuote'> | null;
  /** 종목 로고 */
  logos?: Logos | null;
  /** 업비트(연결 점검용) */
  upbit?: Pick<UpbitClient, 'markets' | 'krwPrices'> | null;
  /** 코인 공포·탐욕 지수 */
  sentiment?: (() => Promise<Sentiment | null>) | null;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, trustProxy: true, bodyLimit: 1024 * 1024 });
  await registerStatic(app, deps.webDist);
  app.get('/api/health', async () => ({ ok: true, up: Math.round(process.uptime()) }));
  await registerAuth(app, deps);
  registerMarketRoutes(app, { ...deps, badgeLookup: deps.badgeLookup ?? badgeLookupFor(deps.db) });
  registerAdminRoutes(app, deps);
  registerAiRoutes(app, deps);
  registerFeedRoutes(app, { ...deps, vapidPublicKey: deps.push.publicKey() });
  registerSettingsRoutes(app, deps);
  registerDiagnoseRoutes(app, deps);
  registerInfoRoutes(app, deps);
  registerHoldingsRoutes(app, deps);
  registerAlertRoutes(app, deps);
  return app;
}
