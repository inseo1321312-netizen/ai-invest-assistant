import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { openDb } from '../../src/db.js';
import { createBudget } from '../../src/ai/budget.js';
import { createSiwcTokenStore, SiwcAuthError, type SiwcTokens } from '../../src/ai/siwcTokens.js';
import { SIWC_TOKEN_URL } from '../../src/ai/siwcConfig.js';
import { createGptAdapter } from '../../src/ai/gpt.js';
import { createAiRouter, DEFAULT_MODELS } from '../../src/ai/router.js';
import type { AiAdapter, AiEvent, AiRequest, AiTool } from '../../src/ai/types.js';
import { makeClock } from '../helpers.js';
import { fakeFetch } from '../fakeFetch.js';

const TOKEN_PATH = new URL(SIWC_TOKEN_URL).pathname;

function tokens(over: Partial<SiwcTokens> = {}): SiwcTokens {
  return {
    clientId: 'oaiapp_test', accessToken: 'AT1', refreshToken: 'RT1', idToken: null,
    expiresAt: Date.now() + 3600_000, scopes: ['openid', 'offline_access', 'chatgpt.tokens.use.direct'], ...over,
  };
}

function sse(events: object[], status = 200) {
  const body = events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } });
}

const textTurn = (text: string, usage = { input_tokens: 0, output_tokens: 0 }) => sse([
  { type: 'response.created', response: { id: 'r1' } },
  { type: 'response.output_text.delta', delta: text, item_id: 'm1', output_index: 0, content_index: 0 },
  { type: 'response.completed', response: { id: 'r1', model: 'gpt-6-luna', output: [], usage } },
]);

async function collect(it: AsyncIterable<AiEvent>) {
  const out: AiEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

function req(extra: Partial<AiRequest> = {}): AiRequest {
  return { provider: 'gpt', tier: 'light', purpose: 'interactive', instructions: 'SYS', history: [{ role: 'user', text: 'q0' }, { role: 'assistant', text: 'a0' }], userText: '질문', tools: [], webSearch: null, ...extra };
}

describe('siwc token store', () => {
  test('save rejects tokens without plan-usage scope', () => {
    const store = createSiwcTokenStore({ db: openDb(':memory:'), fetchImpl: fakeFetch({}) });
    expect(() => store.save(tokens({ scopes: ['openid'] }))).toThrow(/chatgpt.tokens.use.direct/);
  });

  test('fresh token returned without refresh', async () => {
    const f = fakeFetch({});
    const store = createSiwcTokenStore({ db: openDb(':memory:'), fetchImpl: f });
    store.save(tokens());
    expect(await store.getAccessToken()).toBe('AT1');
    expect(f.calls).toHaveLength(0);
  });

  test('single-flight refresh under concurrent calls', async () => {
    const db = openDb(':memory:');
    const f = fakeFetch({ [TOKEN_PATH]: async (_u, init) => {
      const form = new URLSearchParams(String(init?.body));
      expect(Object.fromEntries(form)).toEqual({ grant_type: 'refresh_token', client_id: 'oaiapp_test', refresh_token: 'RT1', resource: 'https://api.openai.com/v1' });
      await new Promise((r) => setTimeout(r, 5));
      return { access_token: 'AT2', refresh_token: 'RT2', expires_in: 3600, scope: 'openid offline_access chatgpt.tokens.use.direct', token_type: 'Bearer' };
    } });
    const store = createSiwcTokenStore({ db, fetchImpl: f });
    store.save(tokens({ expiresAt: Date.now() - 1000 }));
    const got = await Promise.all([store.getAccessToken(), store.getAccessToken(), store.getAccessToken()]);
    expect(got).toEqual(['AT2', 'AT2', 'AT2']);
    expect(f.count(TOKEN_PATH)).toBe(1);
    expect(db.kvGet<SiwcTokens>('siwc.tokens')!.refreshToken).toBe('RT2');
  });

  test('unusable refresh token clears tokens and throws SiwcAuthError', async () => {
    const f = fakeFetch({ [TOKEN_PATH]: () => new Response(JSON.stringify({ error: 'refresh_token_reused' }), { status: 400 }) });
    const store = createSiwcTokenStore({ db: openDb(':memory:'), fetchImpl: f });
    store.save(tokens({ expiresAt: 1 }));
    await expect(store.getAccessToken()).rejects.toBeInstanceOf(SiwcAuthError);
    expect(store.has()).toBe(false);
  });

  test('server error keeps tokens', async () => {
    const f = fakeFetch({ [TOKEN_PATH]: () => new Response('oops', { status: 500 }) });
    const store = createSiwcTokenStore({ db: openDb(':memory:'), fetchImpl: f });
    store.save(tokens({ expiresAt: 1 }));
    await expect(store.getAccessToken()).rejects.toThrow();
    expect(store.has()).toBe(true);
  });

  test('host id is a stable urn:uuid', () => {
    const db = openDb(':memory:');
    const a = createSiwcTokenStore({ db }).hostId();
    expect(a).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
    expect(createSiwcTokenStore({ db }).hostId()).toBe(a);
  });
});

describe('gpt adapter', () => {
  const lookup: AiTool<{ q: string }> = { name: 'lookup', description: 'd', schema: z.strictObject({ q: z.string() }), async run(i) { return `result:${i.q}`; } };

  function setup(routes: Parameters<typeof fakeFetch>[0], mode: 'siwc' | 'apikey' = 'siwc', apiKey: string | null = null) {
    const db = openDb(':memory:');
    const f = fakeFetch(routes);
    const siwc = createSiwcTokenStore({ db, fetchImpl: f });
    siwc.save(tokens());
    const budget = createBudget(db, makeClock().now);
    const run = createGptAdapter({ mode: () => mode, siwc, apiKey: () => apiKey, budget, fetchImpl: f });
    return { run, f, siwc, budget };
  }

  test('siwc request: stream true, store false, instructions, no temperature/max_output_tokens, full input', async () => {
    const { run, f } = setup({ '/v1/responses': () => textTurn('안녕') });
    const ev = await collect(run(req({ tools: [lookup as AiTool] }), 'gpt-6-luna'));
    expect(ev.filter((e) => e.type === 'text')).toEqual([{ type: 'text', delta: '안녕' }]);
    expect(ev.at(-1)).toMatchObject({ type: 'done', text: '안녕', provider: 'gpt', costUsd: 0 });
    const call = f.calls.find((c) => c.url.pathname === '/v1/responses')!;
    const body = JSON.parse(String(call.init?.body));
    expect(body).toMatchObject({ model: 'gpt-6-luna', stream: true, store: false, instructions: 'SYS' });
    expect(body.temperature).toBeUndefined();
    expect(body.max_output_tokens).toBeUndefined();
    expect(body.input).toEqual([
      { role: 'user', content: 'q0' }, { role: 'assistant', content: 'a0' }, { role: 'user', content: '질문' },
    ]);
    expect(body.input.some((i: { role?: string }) => i.role === 'system')).toBe(false);
    expect(body.tools[0]).toMatchObject({ type: 'function', name: 'lookup', strict: true });
    expect(new Headers(call.init?.headers).get('authorization')).toBe('Bearer AT1');
  });

  test('function call loop resends full input with function_call_output', async () => {
    let n = 0;
    const { run, f } = setup({ '/v1/responses': () => (n++ === 0
      ? sse([
        { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc1', call_id: 'c1', name: 'lookup', arguments: '{"q":"a"}', status: 'completed' } },
        { type: 'response.completed', response: { id: 'r1', output: [], usage: { input_tokens: 0, output_tokens: 0 } } },
      ])
      : textTurn('끝')) });
    const ev = await collect(run(req({ tools: [lookup as AiTool] }), 'gpt-6-luna'));
    expect(ev.at(-1)).toMatchObject({ type: 'done', text: '끝' });
    const second = JSON.parse(String(f.calls.filter((c) => c.url.pathname === '/v1/responses')[1]!.init?.body));
    expect(second.input.slice(-2)).toEqual([
      { type: 'function_call', call_id: 'c1', name: 'lookup', arguments: '{"q":"a"}' },
      { type: 'function_call_output', call_id: 'c1', output: 'result:a' },
    ]);
  });

  test('401 → refresh once → retry; second 401 → auth error', async () => {
    let refreshed = 0;
    const unauthorized = () => new Response(JSON.stringify({ error: { code: 'subscription_sharing_invalid_user', message: 'x' } }), { status: 401 });
    const routes = {
      '/v1/responses': unauthorized,
      [TOKEN_PATH]: () => { refreshed++; return { access_token: 'AT2', refresh_token: 'RT2', expires_in: 3600, scope: 'chatgpt.tokens.use.direct' }; },
    };
    const { run, f } = setup(routes);
    const ev = await collect(run(req(), 'gpt-6-luna'));
    expect(refreshed).toBe(1);
    expect(f.count('/v1/responses')).toBe(2);
    expect(ev.at(-1)).toEqual({ type: 'error', code: 'auth', message: 'ChatGPT 다시 로그인이 필요합니다' });
  });

  test('usage limit 429 → budget error', async () => {
    const { run } = setup({ '/v1/responses': () => new Response(JSON.stringify({ error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'limit' } }), { status: 429 }) });
    const ev = await collect(run(req(), 'gpt-6-luna'));
    expect(ev.at(-1)).toEqual({ type: 'error', code: 'budget', message: 'ChatGPT Plus 사용량 한도에 도달했습니다 (chatgpt.com/settings/usage 에서 확인)' });
  });

  test('response.failed mid-stream with usage limit → budget error', async () => {
    const { run } = setup({ '/v1/responses': () => sse([
      { type: 'response.output_text.delta', delta: '부분', item_id: 'm', output_index: 0, content_index: 0 },
      { type: 'response.failed', response: { id: 'r', error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'limit' } } },
    ]) });
    const ev = await collect(run(req(), 'gpt-6-luna'));
    expect(ev.at(-1)).toMatchObject({ type: 'error', code: 'budget' });
  });

  test('apikey mode uses OPENAI_API_KEY and records cost', async () => {
    const { run, f, budget } = setup({ '/v1/responses': () => textTurn('x', { input_tokens: 1_000_000, output_tokens: 0 }) }, 'apikey', 'sk-test');
    const ev = await collect(run(req(), 'gpt-6-luna'));
    expect(new Headers(f.calls[0]!.init?.headers).get('authorization')).toBe('Bearer sk-test');
    expect((ev.at(-1) as { costUsd: number }).costUsd).toBeCloseTo(0.1, 6);
    expect(budget.usage().gptMonth).toBeCloseTo(0.1, 6);
  });

  test('apikey mode without key → auth error; siwc not connected → auth error', async () => {
    const a = setup({}, 'apikey', null);
    expect((await collect(a.run(req(), 'gpt-6-luna'))).at(-1)).toEqual({ type: 'error', code: 'auth', message: 'ChatGPT API 키가 없어요. 설정 → AI 연결에서 넣어 주세요' });
    const b = setup({});
    b.siwc.clear();
    expect((await collect(b.run(req(), 'gpt-6-luna'))).at(-1)).toEqual({ type: 'error', code: 'auth', message: 'ChatGPT 연결이 필요합니다. 설정에서 안내를 따라 연결하세요' });
  });
});

describe('router', () => {
  test('picks provider from request and model from settings', async () => {
    const seen: string[] = [];
    const fake = (name: string): AiAdapter => async function* (_r, model) { seen.push(`${name}:${model}`); yield { type: 'done', text: '', provider: 'claude', model, costUsd: 0 }; };
    const db = openDb(':memory:');
    const router = createAiRouter({ claude: fake('claude'), gpt: fake('gpt'), db });
    await collect(router.runAi(req({ provider: 'claude', tier: 'deep' })));
    await collect(router.runAi(req({ provider: 'gpt', tier: 'light' })));
    router.setModels({ ...DEFAULT_MODELS, claude: { ...DEFAULT_MODELS.claude, standard: 'claude-opus-5-5' } });
    await collect(router.runAi(req({ provider: 'claude', tier: 'standard' })));
    expect(seen).toEqual(['claude:claude-opus-5-5', 'gpt:gpt-6-luna', 'claude:claude-opus-5-5']);
    expect(DEFAULT_MODELS.claude).toEqual({ light: 'claude-haiku-5-5', standard: 'claude-sonnet-5-5', deep: 'claude-opus-5-5' });
  });

  test('gpt mode defaults to siwc and persists', () => {
    const db = openDb(':memory:');
    const router = createAiRouter({ claude: async function* () {}, gpt: async function* () {}, db });
    expect(router.gptMode()).toBe('siwc');
    router.setGptMode('apikey');
    expect(createAiRouter({ claude: async function* () {}, gpt: async function* () {}, db }).gptMode()).toBe('apikey');
  });
});

describe('gpt thinking depth', () => {
  test('deeper thinking asks for more reasoning; a model that refuses it still answers', async () => {
    const db = openDb(':memory:');
    const bodies: Record<string, unknown>[] = [];
    let n = 0;
    const f = fakeFetch({ '/v1/responses': (_u, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      if (n++ === 0) return new Response(JSON.stringify({ error: { message: "Unsupported parameter: 'reasoning.effort'", type: 'invalid_request_error', param: 'reasoning.effort', code: 'unsupported_parameter' } }), { status: 400, headers: { 'content-type': 'application/json' } });
      return textTurn('답');
    } });
    const siwc = createSiwcTokenStore({ db, fetchImpl: f });
    siwc.save(tokens());
    const run = createGptAdapter({ mode: () => 'siwc', siwc, apiKey: () => null, budget: createBudget(db, makeClock().now), fetchImpl: f });
    const ev = await collect(run(req({ tier: 'deep' }), 'gpt-6.1-terra'));
    expect(bodies[0]!.reasoning).toEqual({ effort: 'high' });
    expect(bodies[1]!.reasoning).toBeUndefined();
    expect(ev.at(-1)).toMatchObject({ type: 'done', text: '답' });
  });

  test('the normal level sends no reasoning setting', async () => {
    const db = openDb(':memory:');
    const f = fakeFetch({ '/v1/responses': () => textTurn('답') });
    const siwc = createSiwcTokenStore({ db, fetchImpl: f });
    siwc.save(tokens());
    const run = createGptAdapter({ mode: () => 'siwc', siwc, apiKey: () => null, budget: createBudget(db, makeClock().now), fetchImpl: f });
    await collect(run(req({ tier: 'standard' }), 'gpt-6.1-sol'));
    expect(JSON.parse(String(f.calls[0]!.init?.body)).reasoning).toBeUndefined();
  });
});

describe('ChatGPT subscription usage', () => {
  test('the real 5-hour usage that ChatGPT reports with an answer is remembered', async () => {
    const db = openDb(':memory:');
    const clock = makeClock();
    const f = fakeFetch({ '/v1/responses': () => {
      const r = textTurn('답');
      r.headers.set('x-codex-primary-used-percent', '37');
      r.headers.set('x-codex-primary-window-minutes', '300');
      r.headers.set('x-codex-primary-reset-after-seconds', '3600');
      return r;
    } });
    const siwc = createSiwcTokenStore({ db, fetchImpl: f });
    siwc.save(tokens());
    const budget = createBudget(db, clock.now);
    const run = createGptAdapter({ mode: () => 'siwc', siwc, apiKey: () => null, budget, fetchImpl: f });
    expect(budget.usage().gptWindow).toBeNull();
    await collect(run(req(), 'gpt-6-luna'));
    expect(budget.usage().gptWindow).toEqual({ usedPct: 37, windowMinutes: 300, resetAt: clock.now() + 3600_000, at: clock.now() });
  });

  test('answers without usage headers leave it unknown', async () => {
    const db = openDb(':memory:');
    const f = fakeFetch({ '/v1/responses': () => textTurn('답') });
    const siwc = createSiwcTokenStore({ db, fetchImpl: f });
    siwc.save(tokens());
    const budget = createBudget(db, makeClock().now);
    await collect(createGptAdapter({ mode: () => 'siwc', siwc, apiKey: () => null, budget, fetchImpl: f })(req(), 'gpt-6-luna'));
    expect(budget.usage().gptWindow).toBeNull();
  });
});
