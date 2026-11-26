import { describe, expect, test } from 'vitest';
import { openDb } from '../../src/db.js';
import { createModelCatalog, fetchGptModels } from '../../src/ai/modelCatalog.js';
import { createAiRouter, DEFAULT_MODELS } from '../../src/ai/router.js';
import { createBudget } from '../../src/ai/budget.js';
import type { AiAdapter, AiRequest } from '../../src/ai/types.js';
import { makeClock } from '../helpers.js';
import { fakeFetch } from '../fakeFetch.js';

describe('model catalog', () => {
  test('lists live models and caches for an hour', async () => {
    const clock = makeClock();
    let claudeCalls = 0;
    const cat = createModelCatalog({
      now: clock.now,
      listClaude: async () => { claudeCalls++; return [{ id: 'claude-opus-5-5', label: 'Claude Opus 5.5' }, { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' }]; },
      listGpt: async () => [{ id: 'gpt-6-luna', label: 'GPT-6 Luna' }],
    });
    const a = await cat.list();
    expect(a.claude.map((m) => m.id)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5']);
    expect(a.gpt).toEqual([{ id: 'gpt-6-luna', label: 'GPT-6 Luna' }]);
    await cat.list();
    expect(claudeCalls).toBe(1);
    clock.advance(61 * 60_000);
    await cat.list();
    expect(claudeCalls).toBe(2);
  });

  test('falls back to default models when a provider list fails', async () => {
    const cat = createModelCatalog({ now: Date.now, listClaude: async () => { throw new Error('no key'); }, listGpt: async () => { throw new Error('not connected'); } });
    const l = await cat.list();
    expect(l.claude.map((m) => m.id)).toEqual(Object.values(DEFAULT_MODELS.claude).sort());
    expect(l.gpt.map((m) => m.id)).toEqual(Object.values(DEFAULT_MODELS.gpt).sort());
  });

  test('isAllowed checks provider list', async () => {
    const cat = createModelCatalog({ now: Date.now, listClaude: async () => [{ id: 'claude-haiku-5-5', label: 'H' }], listGpt: async () => [] });
    expect(await cat.isAllowed('claude', 'claude-haiku-5-5')).toBe(true);
    expect(await cat.isAllowed('claude', 'claude-opus-9')).toBe(false);
    expect(await cat.isAllowed('gpt', 'gpt-6.2-sol')).toBe(true); // 목록이 비면 기본 모델 허용
  });

  test('gpt models: SIWC shape (models + visibility) and API shape (data)', async () => {
    const siwc = fakeFetch({ '/v1/models': () => ({ models: [
      { slug: 'gpt-6-luna', display_name: 'GPT-6 Luna', visibility: 'list' },
      { slug: 'gpt-internal', display_name: 'x', visibility: 'hide' },
      { slug: 'gpt-6.2-sol', display_name: 'GPT-6.2 Sol', visibility: 'list' },
    ] }) });
    expect(await fetchGptModels('TOKEN', siwc)).toEqual([{ id: 'gpt-6-luna', label: 'GPT-6 Luna' }, { id: 'gpt-6.2-sol', label: 'GPT-6.2 Sol' }]);
    expect(new Headers(siwc.calls[0]!.init?.headers).get('authorization')).toBe('Bearer TOKEN');
    const api = fakeFetch({ '/v1/models': () => ({ data: [{ id: 'gpt-6-luna' }, { id: 'whisper-1' }, { id: 'gpt-6.1-terra' }] }) });
    expect((await fetchGptModels('K', api)).map((m) => m.id)).toEqual(['gpt-6-luna', 'gpt-6.1-terra']);
  });
});

describe('router model override', () => {
  test('request model overrides the tier table', async () => {
    const seen: string[] = [];
    const adapter: AiAdapter = async function* (_r, model) { seen.push(model); };
    const router = createAiRouter({ claude: adapter, gpt: adapter, db: openDb(':memory:') });
    const req: AiRequest = { provider: 'gpt', tier: 'standard', purpose: 'interactive', instructions: '', history: [], userText: 'x', tools: [], webSearch: null, model: 'gpt-6.2-sol' };
    for await (const _ of router.runAi(req)) { /* drain */ }
    expect(seen).toEqual(['gpt-6.2-sol']);
  });
});

describe('usage summary', () => {
  test('counts GPT requests in the last 5 hours and today, and remembers limit hits', () => {
    const clock = makeClock(Date.UTC(2026, 10, 26, 3, 0)); // KST 12:00
    const b = createBudget(openDb(':memory:'), clock.now);
    b.record('interactive', 'gpt', 0);
    clock.advance(6 * 3600_000); // KST 18:00
    b.record('interactive', 'gpt', 0);
    b.record('interactive', 'gpt', 0);
    b.record('interactive', 'claude', 0.2);
    b.noteLimitHit('gpt');
    const u = b.usage();
    expect(u.requests.gpt5h).toBe(2);
    expect(u.requests.gptToday).toBe(3);
    expect(u.requests.claudeToday).toBe(1);
    expect(u.gptLimitHitAt).toBe(clock.now());
  });
});
