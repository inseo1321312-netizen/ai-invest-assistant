import { mkdirSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { buildApp } from './app.js';
import { createSentiment } from './market/sentiment.js';
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
import { ensureCatchUp, runMorningBriefing } from './features/briefing.js';
import { startScheduler } from './scheduler.js';
import { createModelCatalog, fetchGptModels } from './ai/modelCatalog.js';
import { createPgSnapshotStore, restoreSnapshot, startPersistence, type Persistence } from './persist.js';

/** 잃으면 다시 로그인·재발급이 필요한 값: 바뀌면 곧바로 바깥 저장소에 저장한다 */
const URGENT_KEYS = /^(siwc\.|kis\.token|push\.vapid)/;

async function main() {
  const config = loadConfig(process.env);
  mkdirSync(config.dataDir, { recursive: true });
  const dbFile = path.join(config.dataDir, 'app.db');

  // 무료 서버는 잠들면 디스크가 지워지므로, 켜질 때 바깥 저장소(Neon)에서 되살린다.
  let pool: pg.Pool | null = null;
  let store = null;
  if (config.databaseUrl) {
    pool = new pg.Pool({ connectionString: config.databaseUrl, max: 2, ssl: true });
    store = createPgSnapshotStore((text, params) => pool!.query(text, params as unknown[]));
    try {
      const restored = await restoreSnapshot(store, dbFile);
      console.log(restored ? '저장된 데이터를 되살렸습니다' : '저장된 데이터가 없어 새로 시작합니다');
    } catch (err) {
      console.error('데이터 복원 실패(새로 시작):', err instanceof Error ? err.message : err);
    }
  } else {
    console.warn('DATABASE_URL이 없어 데이터가 이 서버 디스크에만 저장됩니다');
  }

  const db = openDb(dbFile);
  let persistence: Persistence | null = null;
  if (store) {
    persistence = startPersistence({ db, store });
    const kvSet = db.kvSet.bind(db);
    db.kvSet = (key, value) => {
      kvSet(key, value);
      if (URGENT_KEYS.test(key)) persistence!.markUrgent();
    };
  }

  const now = () => Date.now();
  const okx = createOkxClient();
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
  const push = createPush({ vapid: config.vapid, db, subject: config.publicUrl });
  const featureDeps = { db, market, runAi: router.runAi, now, push };
  const runBriefing = () => runMorningBriefing(featureDeps);
  const catchUp = () => ensureCatchUp(featureDeps);
  const checkClaude = anthropic ? async () => { await anthropic.models.list({ limit: 1 }); } : null;

  const app = await buildApp({
    config, db, now, market, connected: { kis: config.kis !== null }, siwc, runAi: router.runAi,
    push, runBriefing, catchUp, settings: { router, budget }, catalog, persistence, checkClaude,
    sentiment: createSentiment({ fetch, now: Date.now }),
    webDist: path.resolve(import.meta.dirname, '../../web/dist'),
  });
  startScheduler({ briefing: runBriefing });
  await app.listen({ host: '0.0.0.0', port: config.port });
  console.log(`서버 시작: 포트 ${config.port}`);
  // 깨어나자마자 밀린 작업(오늘 브리핑, 급변 확인)을 뒤에서 한다
  void catchUp();

  // 서버가 잠들기·재시작 직전에 마지막으로 저장한다
  const shutdown = async (signal: string) => {
    console.log(`${signal}: 저장하고 종료합니다`);
    try {
      await app.close();
      await persistence?.flush();
      await persistence?.stop();
      await pool?.end();
    } finally {
      process.exit(0);
    }
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
