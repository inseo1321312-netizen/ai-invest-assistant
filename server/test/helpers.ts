import { createApiKeys } from '../src/ai/apiKeys.js';
import { openDb } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import type { AppDeps } from '../src/app.js';
import { createMarketService } from '../src/market/service.js';
import { fakeKis, fakeOkx } from './market/fakes.js';
import { createSiwcTokenStore } from '../src/ai/siwcTokens.js';
import { fakeRunAi } from './ai/fakeRunAi.js';
import { createPush } from '../src/push.js';
import { createAiRouter } from '../src/ai/router.js';
import { createBudget } from '../src/ai/budget.js';
import { createModelCatalog } from '../src/ai/modelCatalog.js';

export const FIXED_NOW = Date.UTC(2026, 10, 26, 0, 0, 0); // 2026-11-26 09:00 KST
export const TEST_PASSWORD = 'test-password-123';

export function testConfig(extra: Record<string, string> = {}) {
  return loadConfig({ APP_PASSWORD: TEST_PASSWORD, SESSION_SECRET: 's'.repeat(32), NODE_ENV: 'test', ...extra });
}

export interface TestClock { now: () => number; set(ms: number): void; advance(ms: number): void }

export function makeClock(start = FIXED_NOW): TestClock {
  let t = start;
  return { now: () => t, set: (ms) => { t = ms; }, advance: (ms) => { t += ms; } };
}

export function testDeps(overrides: Partial<AppDeps> = {}): AppDeps & { clock: TestClock } {
  const clock = makeClock();
  const db = overrides.db ?? openDb(':memory:');
  const market = createMarketService({ okx: fakeOkx(), kis: fakeKis(), db, now: clock.now, fx: async () => 1400 });
  return { config: testConfig(), db, now: clock.now, clock, market, connected: { kis: false }, siwc: createSiwcTokenStore({ db, now: clock.now }), runAi: fakeRunAi([]).runAi, push: createPush({ vapid: null, db }), settings: { router: createAiRouter({ claude: async function* () {}, gpt: async function* () {}, db }), budget: createBudget(db, clock.now), keys: createApiKeys({ db, secret: 'test-secret-'.repeat(4), env: { claude: null, openai: null } }), verifyKey: async () => 'ok' as const }, catalog: createModelCatalog({ now: clock.now, listClaude: async () => [], listGpt: async () => [] }), ...overrides } as AppDeps & { clock: TestClock };
}

/** 로그인 후 세션 쿠키 헤더 값을 돌려준다. */
export async function loginCookie(app: { inject: Function }): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/login', payload: { password: TEST_PASSWORD } });
  const set = res.headers['set-cookie'];
  const raw = Array.isArray(set) ? set[0] : set;
  if (!raw) throw new Error('no cookie');
  return String(raw).split(';')[0]!;
}
