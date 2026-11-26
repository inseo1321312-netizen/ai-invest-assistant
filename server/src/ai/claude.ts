import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { Budget } from './budget.js';
import { costUsd, type UsageCounts } from './pricing.js';
import { AsyncQueue } from './queue.js';
import type { AiAdapter, AiEvent, AiTool, Tier } from './types.js';

const MAX_TOOL_ROUNDS = 8;
const EFFORT: Record<Tier, 'low' | 'medium' | 'high'> = { light: 'low', standard: 'medium', deep: 'high' };
const FALLBACK_MODELS = new Set(['claude-sonnet-5-5', 'claude-opus-5-5']);
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/** Anthropic SDK 중 여기서 쓰는 부분만(테스트에서 가짜로 바꾸기 쉽게). */
export interface ClaudeClientLike {
  beta: { messages: { stream(params: any, options?: { signal?: AbortSignal }): { on(ev: 'text', cb: (d: string) => void): unknown; finalMessage(): Promise<any> } } };
}

export function toolJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _drop, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}

function webSearchTool(model: string, maxUses: number) {
  // Haiku 5.5는 동적 필터링 버전을 지원하지 않는다.
  const type = model.includes('haiku') ? 'web_search_20250305' : 'web_search_20260209';
  return { type, name: 'web_search', max_uses: maxUses };
}

export function classifyClaudeError(err: unknown): AiEvent | null {
  if (err instanceof Anthropic.APIUserAbortError) return null;
  if (err instanceof Anthropic.APIError) {
    const text = `${err.message ?? ''} ${JSON.stringify(err.error ?? '')}`;
    if ([400, 402, 429].includes(err.status ?? 0) && /spend[_ ]limit|usage limit|credit balance|enforced_spend_limit_reached/i.test(text)) {
      return { type: 'error', code: 'budget', message: '이번 달 AI 사용 한도에 도달했습니다' };
    }
    if (err.status === 401 || err.status === 403) return { type: 'error', code: 'auth', message: 'Claude API 키를 확인하세요' };
    if (err.status === 429) return { type: 'error', code: 'provider', message: 'Claude 요청이 많아요. 잠시 뒤에 다시 시도하세요' };
  }
  return { type: 'error', code: 'provider', message: 'Claude 응답 중 오류가 났습니다' };
}

export function createClaudeAdapter(opts: { client: ClaudeClientLike; budget: Budget }): AiAdapter {
  return async function* runClaude(req, model) {
    const allowed = opts.budget.check(req.purpose, 'claude');
    if (!allowed.ok) {
      yield { type: 'error', code: 'budget', message: allowed.message };
      return;
    }
    const toolsByName = new Map<string, AiTool>(req.tools.map((t) => [t.name, t]));
    const tools: unknown[] = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: toolJsonSchema(t.schema),
      strict: true,
      eager_input_streaming: true,
    }));
    if (req.webSearch) tools.push(webSearchTool(model, req.webSearch.maxUses));

    const messages: any[] = [
      ...req.history.map((t) => ({ role: t.role, content: t.text })),
      { role: 'user', content: req.userText },
    ];
    let totalCost = 0;
    let fullText = '';
    let servedModel = model;

    try {
      for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
        if (req.signal?.aborted) return;
        const params: Record<string, unknown> = {
          model,
          max_tokens: 16000,
          system: req.instructions,
          messages,
          cache_control: { type: 'ephemeral' },
          output_config: { effort: EFFORT[req.tier] },
        };
        if (tools.length) params.tools = tools;
        if (FALLBACK_MODELS.has(model)) {
          params.betas = [FALLBACK_BETA];
          params.fallbacks = 'default';
        }

        const queue = new AsyncQueue<AiEvent>();
        const stream = opts.client.beta.messages.stream(params, { signal: req.signal });
        stream.on('text', (delta) => {
          fullText += delta;
          queue.push({ type: 'text', delta });
        });
        const finalP = stream.finalMessage().finally(() => queue.close());
        for await (const ev of queue) yield ev;
        const msg = await finalP;

        servedModel = msg.model ?? model;
        const u = msg.usage ?? {};
        const usage: UsageCounts = {
          input: u.input_tokens ?? 0,
          output: u.output_tokens ?? 0,
          cacheRead: u.cache_read_input_tokens ?? 0,
          cacheWrite: u.cache_creation_input_tokens ?? 0,
          webSearches: u.server_tool_use?.web_search_requests ?? 0,
        };
        totalCost += costUsd(servedModel, usage);

        if (msg.stop_reason === 'refusal') {
          opts.budget.record(req.purpose, 'claude', totalCost);
          yield { type: 'error', code: 'refusal', message: 'AI가 이 요청에는 답하지 않았습니다. 질문을 바꿔 보세요' };
          return;
        }
        if (msg.stop_reason === 'pause_turn') {
          messages.push({ role: 'assistant', content: msg.content });
          continue;
        }
        const toolUses = (msg.content as any[]).filter((b) => b.type === 'tool_use');
        if (msg.stop_reason === 'max_tokens') {
          opts.budget.record(req.purpose, 'claude', totalCost);
          yield { type: 'error', code: 'provider', message: '답변이 너무 길어 중간에 멈췄습니다' };
          return;
        }
        if (msg.stop_reason !== 'tool_use' || toolUses.length === 0) break;

        messages.push({ role: 'assistant', content: msg.content });
        const results: any[] = [];
        for (const use of toolUses) {
          const tool = toolsByName.get(use.name);
          const parsed = tool?.schema.safeParse(use.input);
          if (!tool || !parsed?.success) {
            results.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: JSON.stringify({ INVALID_INPUT: use.input ?? null }) });
            continue;
          }
          yield { type: 'status', message: `${tool.name} 확인 중…` };
          const emitted: AiEvent[] = [];
          try {
            const content = await tool.run(parsed.data, { emit: (ev) => emitted.push(ev) });
            results.push({ type: 'tool_result', tool_use_id: use.id, content });
          } catch (err) {
            results.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: err instanceof Error ? err.message : '도구 오류' });
          }
          for (const ev of emitted) yield ev;
        }
        messages.push({ role: 'user', content: results });
      }
    } catch (err) {
      opts.budget.record(req.purpose, 'claude', totalCost);
      const ev = classifyClaudeError(err);
      if (ev) yield ev;
      return;
    }

    opts.budget.record(req.purpose, 'claude', totalCost);
    yield { type: 'done', text: fullText, provider: 'claude', model: servedModel, costUsd: totalCost };
  };
}
