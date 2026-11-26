import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import Anthropic from '@anthropic-ai/sdk';
import { openDb } from '../../src/db.js';
import { createBudget } from '../../src/ai/budget.js';
import { costUsd } from '../../src/ai/pricing.js';
import { createClaudeAdapter } from '../../src/ai/claude.js';
import type { AiEvent, AiRequest, AiTool } from '../../src/ai/types.js';
import { makeClock } from '../helpers.js';
import { fakeClaude } from './fakeClaude.js';

async function collect(it: AsyncIterable<AiEvent>) {
  const out: AiEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

function req(extra: Partial<AiRequest> = {}): AiRequest {
  return { provider: 'claude', tier: 'standard', purpose: 'interactive', instructions: 'SYS', history: [], userText: '안녕', tools: [], webSearch: null, ...extra };
}

describe('pricing', () => {
  test('sonnet cost with web searches', () => {
    expect(costUsd('claude-sonnet-5-5', { input: 1_000_000, output: 100_000, cacheRead: 0, cacheWrite: 0, webSearches: 3 })).toBeCloseTo(2 + 1 + 0.03, 6);
  });
  test('cache read and write priced separately', () => {
    expect(costUsd('claude-haiku-5-5', { input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 1_000_000, webSearches: 0 })).toBeCloseTo(0.01 + 0.125, 6);
  });
  test('unknown model priced at most expensive rate', () => {
    expect(costUsd('mystery-model', { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, webSearches: 0 })).toBe(8); // 표에서 가장 비싼 입력 단가(Fable 5.2)
  });
});

describe('budget', () => {
  test('blocks scheduled purpose separately from interactive', () => {
    const b = createBudget(openDb(':memory:'), makeClock().now);
    b.record('scheduled', 'claude', 1.5);
    expect(b.check('scheduled', 'claude')).toEqual({ ok: false, message: '오늘 예약 작업 AI 사용 한도에 도달했습니다' });
    expect(b.check('interactive', 'claude')).toEqual({ ok: true });
  });

  test('day boundary is Asia/Seoul', () => {
    const clock = makeClock(Date.UTC(2026, 10, 26, 14, 59)); // KST 23:59
    const b = createBudget(openDb(':memory:'), clock.now);
    b.record('interactive', 'claude', 3);
    expect(b.check('interactive', 'claude').ok).toBe(false);
    clock.set(Date.UTC(2026, 10, 26, 15, 0)); // KST 다음날 00:00
    expect(b.check('interactive', 'claude').ok).toBe(true);
  });

  test('monthly limit across purposes and gpt api limit', () => {
    const db = openDb(':memory:');
    const clock = makeClock(Date.UTC(2026, 10, 1, 0, 0));
    const b = createBudget(db, clock.now);
    for (let d = 0; d < 28; d++) { b.record('interactive', 'claude', 2.9); clock.advance(86400_000); }
    expect(b.check('interactive', 'claude')).toEqual({ ok: false, message: '이번 달 AI 사용 한도에 도달했습니다' });
    const b2 = createBudget(openDb(':memory:'), makeClock().now);
    b2.record('interactive', 'gpt', 5);
    expect(b2.check('interactive', 'gpt')).toEqual({ ok: false, message: '이번 달 GPT API 사용 한도에 도달했습니다' });
    expect(b2.check('interactive', 'claude').ok).toBe(false); // 하루 3달러 한도는 공급자 합산
  });

  test('usage summary', () => {
    const b = createBudget(openDb(':memory:'), makeClock().now);
    b.record('interactive', 'claude', 0.5);
    b.record('scheduled', 'claude', 0.25);
    expect(b.usage()).toMatchObject({ today: { interactive: 0.5, scheduled: 0.25 }, month: 0.75 });
  });
});

describe('claude adapter', () => {
  const echo: AiTool<{ q: string }> = {
    name: 'lookup', description: 'look up', schema: z.strictObject({ q: z.string() }),
    async run(input) { return `result:${input.q}`; },
  };

  function adapter(script: Parameters<typeof fakeClaude>[0]) {
    const fake = fakeClaude(script);
    const budget = createBudget(openDb(':memory:'), makeClock().now);
    return { run: createClaudeAdapter({ client: fake.client, budget }), fake, budget };
  }

  test('streams text deltas then done with cost', async () => {
    const { run, budget } = adapter([{ texts: ['안', '녕'], stop_reason: 'end_turn', usage: { input_tokens: 1_000_000, output_tokens: 0 } }]);
    const ev = await collect(run(req(), 'claude-sonnet-5-5'));
    expect(ev.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta)).toEqual(['안', '녕']);
    const done = ev.at(-1)!;
    expect(done).toMatchObject({ type: 'done', text: '안녕', provider: 'claude', model: 'claude-sonnet-5-5' });
    expect((done as { costUsd: number }).costUsd).toBeCloseTo(2, 6);
    expect(budget.usage().today.interactive).toBeCloseTo(2, 6);
  });

  test('runs tool, sends results in one user message, continues', async () => {
    const { run, fake } = adapter([
      { stop_reason: 'tool_use', content: [
        { type: 'tool_use', id: 't1', name: 'lookup', input: { q: 'a' } },
        { type: 'tool_use', id: 't2', name: 'lookup', input: { q: 'b' } },
      ] },
      { texts: ['끝'], stop_reason: 'end_turn' },
    ]);
    const ev = await collect(run(req({ tools: [echo as AiTool] }), 'claude-sonnet-5-5'));
    expect(ev.at(-1)).toMatchObject({ type: 'done', text: '끝' });
    const second = fake.params[1];
    const last = second.messages.at(-1);
    expect(last.role).toBe('user');
    expect(last.content).toEqual([
      { type: 'tool_result', tool_use_id: 't1', content: 'result:a' },
      { type: 'tool_result', tool_use_id: 't2', content: 'result:b' },
    ]);
    expect(fake.params[0].tools[0]).toMatchObject({ name: 'lookup', strict: true, eager_input_streaming: true });
    expect(fake.params[0].tools[0].input_schema.additionalProperties).toBe(false);
  });

  test('invalid tool input returns is_error result without running tool', async () => {
    let ran = false;
    const tool: AiTool<{ q: string }> = { ...echo, async run() { ran = true; return 'x'; } };
    const { run, fake } = adapter([
      { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'lookup', input: { q: 5 } }] },
      { texts: ['ok'], stop_reason: 'end_turn' },
    ]);
    await collect(run(req({ tools: [tool as AiTool] }), 'claude-sonnet-5-5'));
    expect(ran).toBe(false);
    expect(fake.params[1].messages.at(-1).content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 't1', is_error: true });
  });

  test('pause_turn re-sends without extra user text', async () => {
    const { run, fake } = adapter([
      { stop_reason: 'pause_turn', content: [{ type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'x' } }] },
      { texts: ['done'], stop_reason: 'end_turn' },
    ]);
    await collect(run(req(), 'claude-sonnet-5-5'));
    expect(fake.calls()).toBe(2);
    expect(fake.params[1].messages.at(-1).role).toBe('assistant');
  });

  test('uses web_search_20260209 for sonnet and web_search_20250305 for haiku', async () => {
    const a = adapter([{ texts: ['x'], stop_reason: 'end_turn' }]);
    await collect(a.run(req({ webSearch: { maxUses: 3 } }), 'claude-sonnet-5-5'));
    expect(a.fake.params[0].tools).toContainEqual({ type: 'web_search_20260209', name: 'web_search', max_uses: 3 });
    const b = adapter([{ texts: ['x'], stop_reason: 'end_turn' }]);
    await collect(b.run(req({ webSearch: { maxUses: 2 }, tier: 'light' }), 'claude-haiku-5-5'));
    expect(b.fake.params[0].tools).toContainEqual({ type: 'web_search_20250305', name: 'web_search', max_uses: 2 });
  });

  test('sonnet/opus include fallbacks default and beta; haiku does not; effort by tier; cache_control set', async () => {
    const a = adapter([{ texts: ['x'], stop_reason: 'end_turn' }]);
    await collect(a.run(req({ tier: 'deep' }), 'claude-opus-5-5'));
    expect(a.fake.params[0]).toMatchObject({ fallbacks: 'default', betas: ['server-side-fallback-2026-07-01'], output_config: { effort: 'high' }, cache_control: { type: 'ephemeral' }, system: 'SYS', max_tokens: 16000 });
    const b = adapter([{ texts: ['x'], stop_reason: 'end_turn' }]);
    await collect(b.run(req({ tier: 'light' }), 'claude-haiku-5-5'));
    expect(b.fake.params[0].fallbacks).toBeUndefined();
    expect(b.fake.params[0].output_config).toEqual({ effort: 'low' });
  });

  test('never sends tool_choice any/tool and never sends thinking', async () => {
    const a = adapter([{ texts: ['x'], stop_reason: 'end_turn' }]);
    await collect(a.run(req({ tools: [echo as AiTool] }), 'claude-sonnet-5-5'));
    expect(a.fake.params[0].tool_choice).toBeUndefined();
    expect(a.fake.params[0].thinking).toBeUndefined();
  });

  test('history becomes messages before user text', async () => {
    const a = adapter([{ texts: ['x'], stop_reason: 'end_turn' }]);
    await collect(a.run(req({ history: [{ role: 'user', text: 'q1' }, { role: 'assistant', text: 'a1' }], userText: 'q2' }), 'claude-sonnet-5-5'));
    expect(a.fake.params[0].messages).toEqual([
      { role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' }, { role: 'user', content: 'q2' },
    ]);
  });

  test('stops with budget error and does not retry', async () => {
    const err = new Anthropic.RateLimitError(429, { type: 'error', error: { type: 'rate_limit_error', message: 'enforced_spend_limit_reached' } }, 'enforced_spend_limit_reached', new Headers());
    const { run, fake } = adapter([err, { texts: ['never'], stop_reason: 'end_turn' }]);
    const ev = await collect(run(req(), 'claude-sonnet-5-5'));
    expect(ev).toEqual([{ type: 'error', code: 'budget', message: '이번 달 AI 사용 한도에 도달했습니다' }]);
    expect(fake.calls()).toBe(1);
  });

  test('local budget exhausted → error before calling API', async () => {
    const { run, fake, budget } = adapter([{ texts: ['x'], stop_reason: 'end_turn' }]);
    budget.record('interactive', 'claude', 10);
    const ev = await collect(run(req(), 'claude-sonnet-5-5'));
    expect(ev).toEqual([{ type: 'error', code: 'budget', message: '오늘 AI 사용 한도에 도달했습니다' }]);
    expect(fake.calls()).toBe(0);
  });

  test('refusal stop_reason → refusal error event', async () => {
    const { run } = adapter([{ stop_reason: 'refusal' }]);
    const ev = await collect(run(req(), 'claude-sonnet-5-5'));
    expect(ev.at(-1)).toMatchObject({ type: 'error', code: 'refusal' });
  });

  test('401 → auth error', async () => {
    const err = new Anthropic.AuthenticationError(401, { type: 'error', error: { type: 'authentication_error', message: 'bad key' } }, 'bad key', new Headers());
    const { run } = adapter([err]);
    expect((await collect(run(req(), 'claude-sonnet-5-5'))).at(-1)).toMatchObject({ type: 'error', code: 'auth' });
  });

  test('tool emit events are forwarded', async () => {
    const chartTool: AiTool<{ q: string }> = { ...echo, async run(_i, ctx) { ctx.emit({ type: 'status', message: '차트' }); return 'ok'; } };
    const { run } = adapter([
      { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'lookup', input: { q: 'a' } }] },
      { texts: ['끝'], stop_reason: 'end_turn' },
    ]);
    const ev = await collect(run(req({ tools: [chartTool as AiTool] }), 'claude-sonnet-5-5'));
    expect(ev).toContainEqual({ type: 'status', message: '차트' });
  });
});
